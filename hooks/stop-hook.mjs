#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveCloneToken } from '../scripts/clone-auth.mjs'
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

let LOOP_STATE_FILE = resolve(process.cwd(), '.claude', 'clone-loop.local.md')
let LOOP_HISTORY_FILE = resolve(process.cwd(), '.claude', 'clone-loop.history.local.jsonl')
const CLIENT_VERSION = '0.14.3'
const ANSI_BOLD = '\u001b[1m'
const ANSI_PURPLE = '\u001b[35m'
const ANSI_RESET = '\u001b[0m'

function appendHistory(record) {
  appendLoopHistory(LOOP_HISTORY_FILE, record)
}

function readStdin() {
  return new Promise((resolveRead) => {
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      input += chunk
    })
    process.stdin.on('end', () => resolveRead(input))
  })
}

function parseJson(input) {
  const normalized = input.replace(/^\uFEFF/, '').trim()
  return normalized ? JSON.parse(normalized) : {}
}

function removeState() {
  removeLoopState(LOOP_STATE_FILE)
}

function block(reason, systemMessage) {
  console.log(JSON.stringify({ decision: 'block', reason, systemMessage }, null, 2))
}

function formatPromptLines(value) {
  return String(value || '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
}

function purple(value) {
  return `${ANSI_PURPLE}${value}${ANSI_RESET}`
}

function purpleBold(value) {
  return `${ANSI_BOLD}${ANSI_PURPLE}${value}${ANSI_RESET}`
}

function formatIterationPromptLine({ iteration, prompt }) {
  const [firstLine = '', ...remainingLines] = formatPromptLines(prompt)
  const continuation = remainingLines.length
    ? `\n${remainingLines.map((line) => purpleBold(`> ${line}`)).join('\n')}`
    : ''
  return `${purpleBold(`Iteration ${iteration} : ${firstLine}`)}${continuation}`
}

function formatPredictedPromptSection({ iteration, predictedResponse, predictedConfidence, cloneThreshold, prediction }) {
  const roundedConfidence = Number(predictedConfidence).toFixed(5)
  return `${formatIterationPromptLine({ iteration, prompt: predictedResponse })}

Confidence: ${roundedConfidence} / threshold: ${cloneThreshold}
Prediction status: ${prediction.status || ''}
Prediction id: ${prediction.id || ''}`
}

function isIntegerString(value) {
  return /^[0-9]+$/.test(String(value || ''))
}

function parseSse(text) {
  const frames = text
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n')
        .trim(),
    )
    .filter(Boolean)

  for (const frame of frames) {
    try {
      return JSON.parse(frame)
    } catch {}
  }

  return JSON.parse(text)
}

async function rpc(endpoint, token, method, params = {}, sessionId = '') {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-Clone-API-Key': token,
  }
  if (sessionId) headers['mcp-session-id'] = sessionId

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Clone MCP ${method} failed with HTTP ${res.status}: ${text.slice(0, 500)}`)
  }

  return {
    sessionId: res.headers.get('mcp-session-id') || sessionId,
    payload: text ? parseSse(text) : null,
  }
}

async function clonePredictNextPrompt({ agent, agentInput, threshold, sessionId }) {
  const endpoint = process.env.CLONE_MCP_URL || 'https://api.clone.is/mcp'
  const { token } = resolveCloneToken()

  const init = await rpc(endpoint, token, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'clone-loop', version: CLIENT_VERSION },
  })

  const args = {
    agent,
    agent_input: agentInput,
    k: 1,
    threshold: Number(threshold || '0.6'),
  }
  if (sessionId) args.session_id = sessionId

  const prediction = await rpc(
    endpoint,
    token,
    'tools/call',
    { name: 'predict_next_prompt', arguments: args },
    init.sessionId,
  )

  const content = prediction.payload?.result?.content?.[0]
  if (!content || content.type !== 'text') {
    throw new Error('Clone MCP returned no text prediction content.')
  }
  return JSON.parse(content.text)
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

async function main() {
  const hookInput = parseJson(await readStdin())
  if (hookInput.stop_hook_active === true) return

  const root = hookInput.cwd ? resolve(String(hookInput.cwd)) : process.cwd()
  LOOP_STATE_FILE = resolve(root, '.claude', 'clone-loop.local.md')
  LOOP_HISTORY_FILE = resolve(root, '.claude', 'clone-loop.history.local.jsonl')
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
    session_id: stateSession,
    clone_threshold: cloneThresholdRaw,
    clone_agent: cloneAgentRaw,
  } = state.frontmatter

  const cloneThreshold = cloneThresholdRaw || '0.6'
  const cloneAgent = cloneAgentRaw || 'Claude Code Clone Loop'

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
    removeState()
    return
  }

  const promptText = state.prompt.trim()
  if (!promptText) {
    console.error('Clone Loop: State file has no prompt text; stopping.')
    removeState()
    return
  }

  const nextIteration = Number(iteration) + 1
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
      sessionId: hookSession,
    })
  } catch (error) {
    appendHistory({
      event: 'stop',
      decision: 'escalate-mcp-error',
      iteration: nextIteration,
      error: error?.message || String(error),
    })
    removeState()
    block(`Clone Loop requires human escalation.

Clone MCP failed while predicting the next user prompt:
${error?.message || String(error)}

The loop state file has been removed. Tell the user Clone could not produce a safe automatic continuation and wait for human input.`, 'Clone Loop stopped because Clone MCP failed.')
    return
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
