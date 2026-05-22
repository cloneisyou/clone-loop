#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatPredictedPromptSection, purpleBold } from '../scripts/clone-display.mjs'
import { loopHistoryPath, loopStatePath } from '../scripts/clone-paths.mjs'
import {
  HISTORY_WINDOW_TURNS,
  assistantTextsThisIteration,
  formatConversationHistory,
  iterationBlocksThisIteration,
  iterationTimelinesByBoundary,
  loadInjectedUserTurns,
  loadIterationBoundaries,
} from '../scripts/conversation-context.mjs'
import {
  appendLoopHistory,
  removeLoopState,
  validateActiveLoopState,
} from '../scripts/loop-state-guard.mjs'
import {
  clonePredictNextPrompt,
  recordAgentPrompt,
  recordAgentResponse,
  stopCloneSession,
  submitFeedback,
} from '../scripts/clone-mcp.mjs'
import { isIntegerString, parseJson, readStdin } from '../scripts/clone-utils.mjs'

let LOOP_STATE_FILE = loopStatePath()
let LOOP_HISTORY_FILE = loopHistoryPath()

function appendHistory(record) {
  appendLoopHistory(LOOP_HISTORY_FILE, record)
}

function removeState() {
  removeLoopState(LOOP_STATE_FILE)
}

function block(reason, systemMessage) {
  console.log(JSON.stringify({ decision: 'block', reason, systemMessage }, null, 2))
}

function findLastContinueTs(historyPath) {
  if (!historyPath || !existsSync(historyPath)) return ''
  let raw
  try {
    raw = readFileSync(historyPath, 'utf8')
  } catch {
    return ''
  }
  let lastContinueTs = ''
  let loopStartTs = ''
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line.replace(/^\uFEFF/, ''))
    } catch {
      continue
    }
    if (!record || typeof record !== 'object') continue
    const ts = typeof record.ts === 'string' ? record.ts : ''
    if (!ts) continue
    if (record.event === 'stop' && record.decision === 'continue') {
      if (ts > lastContinueTs) lastContinueTs = ts
    } else if (record.event === 'loop-start' && !loopStartTs) {
      loopStartTs = ts
    }
  }
  return lastContinueTs || loopStartTs || ''
}

function updateFrontmatter(content, key, value) {
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const replacement = `${key}: "${escaped}"`
  const pattern = new RegExp(`^${key}: .*$`, 'm')
  if (pattern.test(content)) {
    return content.replace(pattern, replacement)
  }
  return content.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_, body) => `---\n${body}\n${replacement}\n---`)
}

async function safeRecordResponse({ cloneSessionId, mcpSessionId, agent, response, inResponseTo, iteration }) {
  if (!cloneSessionId || !response) return null
  try {
    const result = await recordAgentResponse({
      cloneSessionId,
      mcpSessionId,
      agent,
      response,
      inResponseTo: inResponseTo || undefined,
      source: 'integration',
      sourceDetail: `clone-loop:iteration-${iteration}`,
    })
    appendHistory({ event: 'record-response', iteration, event_id: result?.eventId || null })
    return result
  } catch (error) {
    appendHistory({ event: 'record-response', iteration, error: error?.message || String(error) })
    return null
  }
}

async function safeRecordPrompt({ cloneSessionId, mcpSessionId, agent, prompt, source, iteration }) {
  if (!cloneSessionId || !prompt) return null
  try {
    const result = await recordAgentPrompt({
      cloneSessionId,
      mcpSessionId,
      agent,
      prompt,
      source,
      sourceDetail: `clone-loop:iteration-${iteration}`,
    })
    appendHistory({ event: 'record-prompt', iteration, source, event_id: result?.eventId || null })
    return result
  } catch (error) {
    appendHistory({ event: 'record-prompt', iteration, source, error: error?.message || String(error) })
    return null
  }
}

async function safeFeedback({ predictionId, status, mcpSessionId, iteration }) {
  if (!predictionId) return null
  try {
    await submitFeedback({ predictionId, status, mcpSessionId })
    appendHistory({ event: 'feedback-sent', iteration, prediction_id: predictionId, status })
  } catch (error) {
    appendHistory({
      event: 'feedback-sent',
      iteration,
      prediction_id: predictionId,
      status,
      error: error?.message || String(error),
    })
  }
  return null
}

async function safeStopSession({ cloneSessionId, mcpSessionId, iteration, reason }) {
  if (!cloneSessionId) return
  try {
    await stopCloneSession({
      cloneSessionId,
      mcpSessionId,
      sourceDetail: `clone-loop:stop:${reason}`,
    })
    appendHistory({ event: 'session-stopped', iteration, reason, clone_session_id: cloneSessionId })
  } catch (error) {
    appendHistory({
      event: 'session-stopped',
      iteration,
      reason,
      clone_session_id: cloneSessionId,
      error: error?.message || String(error),
    })
  }
}

async function main() {
  const hookInput = parseJson(await readStdin())
  if (hookInput.stop_hook_active === true) return

  const root = hookInput.cwd ? resolve(String(hookInput.cwd)) : process.cwd()
  LOOP_STATE_FILE = loopStatePath(root)
  LOOP_HISTORY_FILE = loopHistoryPath(root)
  const hookSession = hookInput.session_id ? String(hookInput.session_id) : ''

  const validation = validateActiveLoopState({
    statePath: LOOP_STATE_FILE,
    historyPath: LOOP_HISTORY_FILE,
    hookSession,
    source: 'stop',
  })
  if (!validation.ok) {
    if (validation.reason === 'inactive') return
    console.error(
      `Clone Loop: ${validation.reason}; stale local loop state removed. Run /clone:loop again to start a new loop.`,
    )
    return
  }
  const { state } = validation

  const {
    iteration,
    max_iterations: maxIterations,
    clone_threshold: cloneThresholdRaw,
    clone_agent: cloneAgentRaw,
    clone_session_id: cloneSessionId,
    mcp_session_id: mcpSessionIdInitial,
    last_prompt_event_id: lastPromptEventId,
  } = state.frontmatter

  const cloneThreshold = cloneThresholdRaw || '0.6'
  const cloneAgent = cloneAgentRaw || 'Claude Code Clone Loop'
  let activeMcpSessionId = mcpSessionIdInitial || ''

  if (!isIntegerString(iteration)) {
    console.error('Clone Loop: state file corrupted; iteration is not numeric.')
    removeState()
    return
  }

  if (!isIntegerString(maxIterations)) {
    console.error('Clone Loop: state file corrupted; max_iterations is not numeric.')
    removeState()
    return
  }

  if (Number(maxIterations) > 0 && Number(iteration) >= Number(maxIterations)) {
    console.log(`Clone Loop: Max iterations (${maxIterations}) reached.`)
    appendHistory({
      event: 'stop',
      decision: 'max-iterations',
      iteration: Number(iteration),
      max_iterations: Number(maxIterations),
    })
    await safeStopSession({
      cloneSessionId,
      mcpSessionId: activeMcpSessionId,
      iteration: Number(iteration),
      reason: 'max-iterations',
    })
    removeState()
    return
  }

  const transcriptPath = hookInput.transcript_path ? String(hookInput.transcript_path) : ''
  const sinceTs = findLastContinueTs(LOOP_HISTORY_FILE)

  let iterationBlocks = []
  let assistantTexts = []
  if (transcriptPath && existsSync(transcriptPath)) {
    try {
      iterationBlocks = iterationBlocksThisIteration(transcriptPath, sinceTs)
    } catch (error) {
      console.error('Clone Loop: Failed to parse transcript JSON; falling back to text-only extraction.')
      console.error(`Error: ${error?.message || String(error)}`)
      iterationBlocks = []
    }
    if (!iterationBlocks.length) {
      try {
        assistantTexts = assistantTextsThisIteration(transcriptPath, sinceTs)
      } catch {
        assistantTexts = []
      }
    }
  }

  if (!iterationBlocks.length && !assistantTexts.length) {
    const fallback = hookInput.last_assistant_message ? String(hookInput.last_assistant_message) : ''
    assistantTexts = fallback ? [fallback] : []
  }

  if (!iterationBlocks.length && !assistantTexts.length) {
    console.error('Clone Loop: No assistant messages found; stopping.')
    await safeStopSession({
      cloneSessionId,
      mcpSessionId: activeMcpSessionId,
      iteration: Number(iteration),
      reason: 'no-assistant-text',
    })
    removeState()
    return
  }

  const promptText = state.prompt.trim()
  if (!promptText) {
    console.error('Clone Loop: State file has no prompt text; stopping.')
    await safeStopSession({
      cloneSessionId,
      mcpSessionId: activeMcpSessionId,
      iteration: Number(iteration),
      reason: 'empty-prompt',
    })
    removeState()
    return
  }

  const currentIteration = Number(iteration)
  const nextIteration = currentIteration + 1

  await safeRecordResponse({
    cloneSessionId,
    mcpSessionId: activeMcpSessionId,
    agent: cloneAgent,
    response: assistantTexts.join('\n\n'),
    inResponseTo: lastPromptEventId,
    iteration: currentIteration,
  })

  writeFileSync(LOOP_STATE_FILE, state.content.replace(/^iteration: .*/m, `iteration: ${nextIteration}`))

  const systemMessage = `Clone Loop iteration ${nextIteration}.`

  const injectedUserTurns = loadInjectedUserTurns(LOOP_HISTORY_FILE)

  // Pull per-iteration transcript timelines so prior-iter assistant work
  // (text + tool_use + tool_result) lands under each user (clone-prediction)
  // marker. Drops the current-iteration entry — that one is already rendered
  // as the footer through `iterationBlocks`.
  let priorIterTimelines = []
  if (transcriptPath && existsSync(transcriptPath)) {
    try {
      const boundaries = loadIterationBoundaries(LOOP_HISTORY_FILE)
      const all = iterationTimelinesByBoundary(transcriptPath, boundaries)
      // Last boundary is the in-progress iter; drop it so we don't double up.
      priorIterTimelines = all.slice(0, -1)
    } catch (error) {
      console.error('Clone Loop: Failed to extract prior-iter timelines; continuing without them.')
      console.error(`Error: ${error?.message || String(error)}`)
      priorIterTimelines = []
    }
  }

  const agentInput = formatConversationHistory({
    promptText,
    iteration: nextIteration,
    threshold: cloneThreshold,
    injectedUserTurns,
    assistantTexts,
    iterationBlocks,
    priorIterTimelines,
    windowTurns: HISTORY_WINDOW_TURNS,
  })

  let prediction
  try {
    prediction = await clonePredictNextPrompt({
      agent: cloneAgent,
      agentInput,
      threshold: cloneThreshold,
      sessionId: cloneSessionId || hookSession,
      mcpSessionId: activeMcpSessionId,
    })
  } catch (error) {
    appendHistory({
      event: 'stop',
      decision: 'escalate-mcp-error',
      iteration: nextIteration,
      error: error?.message || String(error),
    })
    await safeStopSession({
      cloneSessionId,
      mcpSessionId: activeMcpSessionId,
      iteration: nextIteration,
      reason: 'escalate-mcp-error',
    })
    removeState()
    block(`Clone Loop requires human escalation.

Clone MCP failed while predicting the next user prompt:
${error?.message || String(error)}

The loop state file has been removed. Tell the user Clone could not produce a safe automatic continuation and wait for human input.`, 'Clone Loop stopped because Clone MCP failed.')
    return
  }
  if (prediction.mcp_session_id && prediction.mcp_session_id !== activeMcpSessionId) {
    activeMcpSessionId = prediction.mcp_session_id
    const updated = updateFrontmatter(readFileSync(LOOP_STATE_FILE, 'utf8'), 'mcp_session_id', activeMcpSessionId)
    writeFileSync(LOOP_STATE_FILE, updated)
  }

  const predictedResponse = prediction.predicted_response || ''
  const predictedConfidence = prediction.confidence
  if (!predictedResponse || predictedConfidence == null) {
    appendHistory({
      event: 'stop',
      decision: 'escalate-incomplete-prediction',
      iteration: nextIteration,
      prediction_id: prediction.id || null,
      status: prediction.status || null,
    })
    await safeFeedback({
      predictionId: prediction.id,
      status: 'rejected',
      mcpSessionId: activeMcpSessionId,
      iteration: nextIteration,
    })
    await safeStopSession({
      cloneSessionId,
      mcpSessionId: activeMcpSessionId,
      iteration: nextIteration,
      reason: 'escalate-incomplete-prediction',
    })
    removeState()
    block('Clone Loop requires human escalation. Clone MCP returned an incomplete prediction, so the loop state file has been removed. Tell the user Clone was not confident enough and wait for human input.', 'Clone Loop stopped because Clone returned an incomplete prediction.')
    return
  }

  // Satisfaction-shaped predictions trigger an early stop: Clone is
  // saying the user would be done if they saw this output, so the
  // loop should exit instead of force-continuing with the prediction
  // as the next prompt. The server (`stop_recommended` on the
  // PredictionCandidate) decides; we just act on the signal here.
  // Gated on confidence so a low-confidence "ship it" doesn't slip
  // through as a hallucination.
  if (
    prediction.stop_recommended === true &&
    Number.isFinite(Number(predictedConfidence)) &&
    Number(predictedConfidence) >= Number(cloneThreshold)
  ) {
    appendHistory({
      event: 'stop',
      decision: 'satisfied',
      iteration: nextIteration,
      confidence: Number(predictedConfidence),
      threshold: Number(cloneThreshold),
      prediction_id: prediction.id || null,
      status: prediction.status || null,
      predicted_response: predictedResponse,
    })
    await safeStopSession({
      cloneSessionId,
      mcpSessionId: activeMcpSessionId,
      iteration: nextIteration,
      reason: 'satisfied',
    })
    removeState()
    const satisfiedPromptSection = formatPredictedPromptSection({
      iteration: nextIteration,
      predictedResponse,
      predictedConfidence,
      cloneThreshold,
      prediction,
    })
    block(
      `${purpleBold('Clone Loop: Clone predicted the task is complete. Additional user instruction is needed.')}\n\n${satisfiedPromptSection}`,
      `Clone Loop ended because Clone signaled satisfaction (confidence ${Number(predictedConfidence).toFixed(5)} ≥ threshold ${cloneThreshold}).`,
    )
    return
  }

  if (Number.isFinite(Number(predictedConfidence)) && Number(predictedConfidence) >= Number(cloneThreshold)) {
    const predictedPromptSection = formatPredictedPromptSection({
      iteration: nextIteration,
      predictedResponse,
      predictedConfidence,
      cloneThreshold,
      prediction,
    })

    appendHistory({
      event: 'stop',
      decision: 'continue',
      iteration: nextIteration,
      confidence: Number(predictedConfidence),
      threshold: Number(cloneThreshold),
      prediction_id: prediction.id || null,
      status: prediction.status || null,
      predicted_response: predictedResponse,
    })

    const recorded = await safeRecordPrompt({
      cloneSessionId,
      mcpSessionId: activeMcpSessionId,
      agent: cloneAgent,
      prompt: predictedResponse,
      source: 'clone-prediction',
      iteration: nextIteration,
    })
    if (recorded?.eventId) {
      const updated = updateFrontmatter(
        readFileSync(LOOP_STATE_FILE, 'utf8'),
        'last_prompt_event_id',
        recorded.eventId,
      )
      writeFileSync(LOOP_STATE_FILE, updated)
    }

    block(`${predictedPromptSection}

The user-configured confidence threshold was met. Evaluate
the prediction in context, then continue as if the user had provided the
predicted prompt when it is consistent with the current task state.
Prediction reasoning: ${prediction.reasoning || ''}
`, systemMessage)
    return
  }

  appendHistory({
    event: 'stop',
    decision: 'escalate-low-confidence',
    iteration: nextIteration,
    confidence: Number(predictedConfidence),
    threshold: Number(cloneThreshold),
    prediction_id: prediction.id || null,
    status: prediction.status || null,
    predicted_response: predictedResponse,
  })
  await safeFeedback({
    predictionId: prediction.id,
    status: 'rejected',
    mcpSessionId: activeMcpSessionId,
    iteration: nextIteration,
  })
  await safeStopSession({
    cloneSessionId,
    mcpSessionId: activeMcpSessionId,
    iteration: nextIteration,
    reason: 'escalate-low-confidence',
  })
  removeState()
  const predictedPromptSection = formatPredictedPromptSection({
    iteration: nextIteration,
    predictedResponse,
    predictedConfidence,
    cloneThreshold,
    prediction,
  })
  block(`Clone Loop requires human escalation.

${predictedPromptSection}

Clone was not confident enough to continue automatically.
The loop state file has been removed. Tell the user Clone was not confident enough and wait for human input.`, 'Clone Loop stopped because Clone confidence was below threshold.')
}

main().catch((error) => {
  console.error(error?.message || String(error))
  process.exit(1)
})
