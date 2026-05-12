#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveCloneToken } from '../scripts/clone-auth.mjs'

const LOOP_STATE_FILE = resolve(process.cwd(), '.claude', 'clone-loop.local.md')
const LOOP_HISTORY_FILE = resolve(process.cwd(), '.claude', 'clone-loop.history.local.jsonl')
const CLIENT_VERSION = '0.2.7'
const ANSI_BOLD = '\u001b[1m'
const ANSI_NEON_RED = '\u001b[91m'
const ANSI_RESET = '\u001b[0m'

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function appendHistory(record) {
  try {
    appendFileSync(LOOP_HISTORY_FILE, `${JSON.stringify({ ts: nowIso(), ...record })}\n`)
  } catch {}
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

function parseYamlScalar(value) {
  const raw = value.trim()
  if (raw === 'null') return null
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return raw
}

function parseState(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const frontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1)
    frontmatter[key] = parseYamlScalar(value)
  }

  return {
    frontmatter,
    prompt: match[2].replace(/^\r?\n/, ''),
    content,
  }
}

function removeState() {
  rmSync(LOOP_STATE_FILE, { force: true })
}

function block(reason, systemMessage) {
  console.log(JSON.stringify({ decision: 'block', reason, systemMessage }, null, 2))
}

function formatBlockquote(value) {
  return String(value || '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join('\n> ')
}

function neonRed(value) {
  return `${ANSI_NEON_RED}${value}${ANSI_RESET}`
}

function neonRedBold(value) {
  return `${ANSI_BOLD}${ANSI_NEON_RED}${value}${ANSI_RESET}`
}

function formatPredictedPromptSection({ predictedResponse, predictedConfidence, cloneThreshold, prediction }) {
  return `${neonRedBold("**Clone predicted the user's next prompt**")}

Confidence: ${predictedConfidence} / threshold: ${cloneThreshold}
Prediction status: ${prediction.status || ''}
Prediction id: ${prediction.id || ''}

${neonRed(`> ${formatBlockquote(predictedResponse)}`)}`
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
    clientInfo: { name: 'clone-claude-plugin', version: CLIENT_VERSION },
  })

  const args = {
    agent,
    agent_input: agentInput,
    k: 1,
    threshold: Number(threshold || '0.8'),
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

function lastAssistantText(transcriptPath) {
  const transcript = readFileSync(transcriptPath, 'utf8')
  const texts = []
  for (const line of transcript.split(/\r?\n/).filter(Boolean)) {
    const parsed = JSON.parse(line.replace(/^\uFEFF/, ''))
    if (parsed.message?.role !== 'assistant') continue
    const content = parsed.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'text') texts.push(block.text || '')
    }
  }
  return texts.at(-1) || ''
}

async function main() {
  const hookInput = parseJson(await readStdin())
  if (!existsSync(LOOP_STATE_FILE)) return

  const state = parseState(readFileSync(LOOP_STATE_FILE, 'utf8'))
  if (!state) {
    console.error('Clone Loop: state file corrupted; frontmatter is missing.')
    removeState()
    return
  }

  const {
    iteration,
    max_iterations: maxIterations,
    session_id: stateSession,
    clone_threshold: cloneThresholdRaw,
    clone_agent: cloneAgentRaw,
  } = state.frontmatter

  const cloneThreshold = cloneThresholdRaw || '0.8'
  const cloneAgent = cloneAgentRaw || 'Claude Code Clone Loop'
  const hookSession = hookInput.session_id ? String(hookInput.session_id) : ''

  if (stateSession && stateSession !== hookSession) return

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

  let lastOutput = hookInput.last_assistant_message ? String(hookInput.last_assistant_message) : ''
  if (!lastOutput) {
    const transcriptPath = hookInput.transcript_path ? String(hookInput.transcript_path) : ''
    if (!transcriptPath || !existsSync(transcriptPath)) {
      console.error('Clone Loop: Transcript file not found; stopping.')
      removeState()
      return
    }

    try {
      lastOutput = lastAssistantText(transcriptPath)
    } catch (error) {
      console.error('Clone Loop: Failed to parse assistant message JSON.')
      console.error(`Error: ${error?.message || String(error)}`)
      removeState()
      return
    }

    if (!lastOutput) {
      console.error('Clone Loop: No assistant messages found; stopping.')
      removeState()
      return
    }
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

  const agentInput = `Original Clone Loop prompt:
${promptText}

Clone Loop iteration: ${nextIteration}
Clone threshold: ${cloneThreshold}

Claude last_assistant_message:
${lastOutput}`

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

  if (Number.isFinite(Number(predictedConfidence)) && Number(predictedConfidence) >= Number(cloneThreshold)) {
    const predictedPromptSection = formatPredictedPromptSection({
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

    block(`You are continuing a Clone Loop.

${predictedPromptSection}

The user-configured confidence threshold was met. The prediction cleared
confidence ${predictedConfidence}. Evaluate
the prediction in context, then continue as if the user had provided the
predicted prompt when it is consistent with the current task state.
Prediction reasoning: ${prediction.reasoning || ''}
`, `${systemMessage}

${predictedPromptSection}`)
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
    predictedResponse,
    predictedConfidence,
    cloneThreshold,
    prediction,
  })
  block(`Clone Loop requires human escalation.

Clone was not confident enough to continue automatically.
- status: ${prediction.status || ''}
- confidence: ${predictedConfidence}
- threshold: ${cloneThreshold}

${predictedPromptSection}

The loop state file has been removed. Tell the user Clone was not confident enough and wait for human input.`, `Clone Loop stopped because Clone confidence was below threshold.

${predictedPromptSection}`)
}

main().catch((error) => {
  console.error(error?.message || String(error))
  process.exit(1)
})
