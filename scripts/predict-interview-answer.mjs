#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveCloneToken } from './clone-auth.mjs'
import { appendLoopHistory, parseState } from './loop-state-guard.mjs'

const CLIENT_VERSION = '0.14.4'

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
  const normalized = String(input || '').replace(/^\uFEFF/, '').trim()
  return normalized ? JSON.parse(normalized) : {}
}

function numeric(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[`*_~"'“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function labelBoundaryMatch(text, label) {
  const normalizedLabel = normalize(label)
  if (!normalizedLabel) return false
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(normalizedLabel)}([^\\p{L}\\p{N}]|$)`, 'u').test(text)
}

export function mapPredictionToOption(predictedResponse, options = []) {
  const labels = options.map((option) => String(option?.label || '').trim()).filter(Boolean)
  if (!labels.length) return ''

  const text = normalize(predictedResponse)
  const firstLine = normalize(String(predictedResponse || '').split(/\r?\n/).find((line) => line.trim()) || '')
  const letterMatch = text.match(/^(?:option\s*)?([a-j])(?:[.)\s:-]|$)/)
  if (letterMatch) {
    const index = letterMatch[1].charCodeAt(0) - 'a'.charCodeAt(0)
    if (labels[index]) return labels[index]
  }

  const exactMatches = labels.filter((label) => {
    const normalizedLabel = normalize(label)
    return normalizedLabel === text || normalizedLabel === firstLine
  })
  if (exactMatches.length === 1) return exactMatches[0]

  const prefixMatches = labels.filter((label) => {
    const normalizedLabel = normalize(label)
    return (
      text.startsWith(`${normalizedLabel} `) ||
      text.startsWith(`${normalizedLabel}.`) ||
      text.startsWith(`${normalizedLabel}:`) ||
      text.startsWith(`${normalizedLabel}-`)
    )
  })
  if (prefixMatches.length === 1) return prefixMatches[0]

  const containedMatches = labels.filter((label) => labelBoundaryMatch(text, label))
  return containedMatches.length === 1 ? containedMatches[0] : ''
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

  return text ? JSON.parse(text) : null
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

async function submitFeedback({ endpoint, token, predictionId, status, actualResponse, mcpSessionId }) {
  if (!predictionId) return
  const args = { prediction_id: predictionId, status }
  if (actualResponse) args.actual_response = actualResponse
  await rpc(endpoint, token, 'tools/call', { name: 'submit_feedback', arguments: args }, mcpSessionId)
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
    k: 3,
    threshold: Number(threshold || '0.75'),
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
  return {
    endpoint,
    token,
    mcpSessionId: prediction.sessionId || init.sessionId,
    prediction: JSON.parse(content.text),
  }
}

function historyPath(root) {
  return resolve(root, '.claude', 'clone-interview.history.local.jsonl')
}

function statePath(root) {
  return resolve(root, '.claude', 'clone-interview.local.md')
}

function appendInterviewHistory(root, record) {
  appendLoopHistory(historyPath(root), record)
}

function loadInterviewState(root) {
  const file = statePath(root)
  if (!existsSync(file)) return null
  return parseState(readFileSync(file, 'utf8'))
}

function isFalse(value) {
  return String(value).trim().toLowerCase() === 'false'
}

function formatOptions(options = []) {
  if (!Array.isArray(options) || !options.length) return '(free-form answer)'
  return options
    .map((option, index) => {
      const label = String(option?.label || '').trim()
      const description = option?.description ? ` - ${String(option.description).trim()}` : ''
      return `${String.fromCharCode(65 + index)}. ${label}${description}`
    })
    .join('\n')
}

function buildAgentInput({ state, question, options, answerKind, lastAssistantMessage }) {
  const frontmatter = state.frontmatter || {}
  const spec = String(state.prompt || '').trim()
  const latest = String(lastAssistantMessage || '').trim()
  return `Clone Interview topic:
${frontmatter.topic || ''}

Current Clone Interview spec / ledger:
${spec || '(empty spec)'}

Latest agent context:
${latest || '(no latest assistant message provided)'}

Interview question:
${question}

Answer kind: ${answerKind}
Options:
${formatOptions(options)}

Predict the exact answer this user would give to the interview question.
Rules:
- Write as the user, not as the agent.
- Preserve concrete scope, constraints, non-goals, and acceptance criteria.
- If options are provided and one clearly matches, answer with that option label.
- If confidence is low, still return the best prediction; the caller will escalate.`
}

function candidateText(candidate) {
  if (!candidate) return ''
  if (typeof candidate === 'string') return candidate
  return String(
    candidate.predicted_response ||
      candidate.response ||
      candidate.text ||
      candidate.content ||
      candidate.message ||
      '',
  )
}

function candidateConfidence(candidate, fallback) {
  if (!candidate || typeof candidate === 'string') return fallback
  return numeric(
    candidate.confidence ??
      candidate.probability ??
      candidate.prob ??
      candidate.p ??
      candidate.score,
    fallback,
  )
}

function rankedCandidates(prediction) {
  const candidates = []
  const topConfidence = numeric(prediction?.confidence, 0)
  if (prediction?.predicted_response) {
    candidates.push({ text: String(prediction.predicted_response), confidence: topConfidence, index: candidates.length })
  }
  for (const candidate of Array.isArray(prediction?.candidates) ? prediction.candidates : []) {
    const text = candidateText(candidate)
    if (!text) continue
    candidates.push({ text, confidence: candidateConfidence(candidate, topConfidence), index: candidates.length })
  }
  return candidates.sort((left, right) => right.confidence - left.confidence || left.index - right.index)
}

function selectAnswer({ prediction, answerKind, options }) {
  const ranked = rankedCandidates(prediction)
  if (answerKind === 'choice' && Array.isArray(options) && options.length) {
    for (const candidate of ranked) {
      const mapped = mapPredictionToOption(candidate.text, options)
      if (mapped) return { answer: mapped, raw: candidate.text, confidence: candidate.confidence }
    }
    return { answer: '', raw: ranked[0]?.text || '', confidence: ranked[0]?.confidence ?? 0 }
  }

  const top = ranked[0]
  return { answer: top?.text || '', raw: top?.text || '', confidence: top?.confidence ?? 0 }
}

export async function predictInterviewAnswer(input, env = process.env) {
  const root = input.cwd ? resolve(String(input.cwd)) : process.cwd()
  const state = loadInterviewState(root)
  const question = String(input.question || '').trim()
  const options = Array.isArray(input.options) ? input.options : []
  const answerKind = input.answer_kind === 'choice' || input.answerKind === 'choice' ? 'choice' : 'freeform'

  if (!state || String(state.frontmatter?.active || '').trim() !== 'true') {
    return { decision: 'inactive', reason: 'Clone Interview is not active.' }
  }
  if (isFalse(state.frontmatter?.auto_answer)) {
    appendInterviewHistory(root, { event: 'interview-escalate', reason: 'auto-answer-disabled', question })
    return { decision: 'escalate', reason: 'Auto-answer disabled.' }
  }
  if (!question) {
    appendInterviewHistory(root, { event: 'interview-escalate', reason: 'missing-question' })
    return { decision: 'escalate', reason: 'No interview question provided.' }
  }

  const stateSession = String(state.frontmatter?.session_id || '').trim()
  const hookSession = String(input.session_id || input.sessionId || '').trim()
  if (stateSession && hookSession && stateSession !== hookSession) {
    appendInterviewHistory(root, {
      event: 'interview-escalate',
      reason: 'session-mismatch',
      state_session_id: stateSession,
      hook_session_id: hookSession,
      question,
    })
    return { decision: 'escalate', reason: 'Session mismatch.' }
  }

  const threshold = String(state.frontmatter?.clone_threshold || '0.75')
  const agent = String(state.frontmatter?.clone_agent || 'Claude Code Clone Interview')
  appendInterviewHistory(root, { event: 'interview-question', question, answer_kind: answerKind })

  let prediction
  let feedbackContext
  try {
    feedbackContext = await clonePredictNextPrompt({
      agent,
      threshold,
      sessionId: stateSession || hookSession || undefined,
      agentInput: buildAgentInput({
        state,
        question,
        options,
        answerKind,
        lastAssistantMessage: input.last_assistant_message || input.lastAssistantMessage || '',
      }),
    })
    prediction = feedbackContext.prediction
  } catch (error) {
    appendInterviewHistory(root, {
      event: 'interview-escalate',
      reason: 'mcp-error',
      question,
      error: error?.message || String(error),
    })
    return { decision: 'escalate', reason: 'Clone MCP failed.', error: error?.message || String(error) }
  }

  const selected = selectAnswer({ prediction, answerKind, options })
  const confidence = numeric(selected.confidence, numeric(prediction?.confidence, 0))
  const thresholdNumber = numeric(threshold, 0.75)
  const base = {
    question,
    answer: selected.answer,
    raw_prediction: selected.raw,
    confidence,
    threshold: thresholdNumber,
    prediction_id: prediction?.id || null,
    status: prediction?.status || null,
  }

  if (selected.answer && confidence >= thresholdNumber) {
    appendInterviewHistory(root, { event: 'interview-auto-answer', ...base })
    try {
      await submitFeedback({
        endpoint: feedbackContext.endpoint,
        token: feedbackContext.token,
        mcpSessionId: feedbackContext.mcpSessionId,
        predictionId: prediction?.id,
        status: 'accepted',
        actualResponse: selected.answer,
      })
      appendInterviewHistory(root, { event: 'feedback-sent', source: 'interview', prediction_id: prediction?.id || null, status: 'accepted' })
    } catch (error) {
      appendInterviewHistory(root, {
        event: 'feedback-sent',
        source: 'interview',
        prediction_id: prediction?.id || null,
        status: 'accepted',
        error: error?.message || String(error),
      })
    }
    return { decision: 'auto', ...base }
  }

  appendInterviewHistory(root, { event: 'interview-escalate', reason: selected.answer ? 'low-confidence' : 'empty-answer', ...base })
  return { decision: 'escalate', suggestion: selected.answer, ...base }
}

async function main() {
  const input = parseJson(await readStdin())
  const result = await predictInterviewAnswer(input)
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message || String(error))
    process.exit(1)
  })
}
