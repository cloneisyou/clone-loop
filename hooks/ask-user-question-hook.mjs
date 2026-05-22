#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
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
  validateActiveLoopState,
} from '../scripts/loop-state-guard.mjs'

const LOOP_STATE_FILE = resolve(process.cwd(), '.claude', 'clone-loop.local.md')
const LOOP_HISTORY_FILE = resolve(process.cwd(), '.claude', 'clone-loop.history.local.jsonl')
const CLIENT_VERSION = '0.14.3'

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

function mapPredictionToOption(predictedResponse, options) {
  const labels = options.map((option) => String(option?.label || '').trim()).filter(Boolean)
  if (!labels.length) return null

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
  return containedMatches.length === 1 ? containedMatches[0] : null
}

function numericConfidence(value, fallback = 0) {
  const confidence = Number(value)
  return Number.isFinite(confidence) ? confidence : fallback
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
  return numericConfidence(
    candidate.confidence ??
      candidate.probability ??
      candidate.prob ??
      candidate.p ??
      candidate.score,
    fallback,
  )
}

function rankedPredictionCandidates(prediction) {
  const candidates = []
  const topConfidence = numericConfidence(prediction?.confidence, 0)

  if (prediction?.predicted_response) {
    candidates.push({
      text: String(prediction.predicted_response),
      confidence: topConfidence,
      index: candidates.length,
    })
  }

  for (const candidate of Array.isArray(prediction?.candidates) ? prediction.candidates : []) {
    const text = candidateText(candidate)
    if (!text) continue
    candidates.push({
      text,
      confidence: candidateConfidence(candidate, topConfidence),
      index: candidates.length,
    })
  }

  return candidates.sort((left, right) => right.confidence - left.confidence || left.index - right.index)
}

function chooseHighestConfidenceOption(prediction, options) {
  const labels = options.map((option) => String(option?.label || '').trim()).filter(Boolean)
  const rankedCandidates = rankedPredictionCandidates(prediction)
  const mapped = []

  for (const candidate of rankedCandidates) {
    const answer = mapPredictionToOption(candidate.text, options)
    if (!answer) continue
    mapped.push({ ...candidate, answer })
  }

  if (mapped.length) return mapped[0]

  return {
    answer: labels[0] || null,
    confidence: rankedCandidates[0]?.confidence ?? 0,
    text: rankedCandidates[0]?.text || '',
    fallback: true,
  }
}

function formatOptions(options) {
  return options
    .map((option, index) => {
      const label = String(option?.label || '').trim()
      const description = option?.description ? ` - ${String(option.description).trim()}` : ''
      return `${String.fromCharCode(65 + index)}. ${label}${description}`
    })
    .join('\n')
}

function safeAssistantTextsThisIteration(transcriptPath, sinceTs) {
  if (!transcriptPath || !existsSync(transcriptPath)) return []
  try {
    return assistantTextsThisIteration(transcriptPath, sinceTs)
  } catch {
    return []
  }
}

function safeIterationBlocksThisIteration(transcriptPath, sinceTs) {
  if (!transcriptPath || !existsSync(transcriptPath)) return []
  try {
    return iterationBlocksThisIteration(transcriptPath, sinceTs)
  } catch {
    return []
  }
}

function safePriorIterTimelines(transcriptPath, historyPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return []
  try {
    const boundaries = loadIterationBoundaries(historyPath)
    const all = iterationTimelinesByBoundary(transcriptPath, boundaries)
    return all.slice(0, -1)
  } catch {
    return []
  }
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
      record = JSON.parse(line.replace(/^﻿/, ''))
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

function buildQuestionAgentInput({
  state,
  question,
  questionIndex,
  questionCount,
  threshold,
  transcriptPath,
  historyPath,
}) {
  const injectedUserTurns = loadInjectedUserTurns(historyPath)
  const sinceTs = findLastContinueTs(historyPath)
  const iterationBlocks = safeIterationBlocksThisIteration(transcriptPath, sinceTs)
  const assistantTexts = iterationBlocks.length
    ? []
    : safeAssistantTextsThisIteration(transcriptPath, sinceTs)
  const priorIterTimelines = safePriorIterTimelines(transcriptPath, historyPath)

  const conversationContext = formatConversationHistory({
    promptText: state.prompt,
    iteration: state.frontmatter.iteration || 'unknown',
    threshold,
    injectedUserTurns,
    assistantTexts,
    iterationBlocks,
    priorIterTimelines,
    windowTurns: HISTORY_WINDOW_TURNS,
  })

  return `${conversationContext}

Claude called AskUserQuestion during the active Clone Loop.
Predict the exact natural-language answer this user would give.
The answer may be one of the listed options or a free-form response.
Return only the answer text the user would type.

Question ${questionIndex + 1} of ${questionCount}
Header: ${question.header || ''}
Question: ${question.question || ''}
Options:
${formatOptions(question.options || [])}`
}

function allowAnswer({ toolInput, answers, confidence, threshold }) {
  console.log(
    JSON.stringify(
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `Clone answered AskUserQuestion with a free-form predicted response. Confidence ${confidence}; threshold ${threshold} is advisory for questions.`,
          updatedInput: {
            ...toolInput,
            questions: toolInput.questions,
            answers: {
              ...(toolInput.answers || {}),
              ...answers,
            },
          },
        },
      },
      null,
      2,
    ),
  )
}

async function safeReject({ predictionId, mcpSessionId }) {
  if (!predictionId) return
  try {
    await submitFeedback({ predictionId, status: 'rejected', mcpSessionId })
    appendHistory({ event: 'feedback-sent', source: 'ask-user-question', prediction_id: predictionId, status: 'rejected' })
  } catch (error) {
    appendHistory({ event: 'feedback-sent', source: 'ask-user-question', prediction_id: predictionId, status: 'rejected', error: error?.message || String(error) })
  }
}

async function main() {
  const hookInput = parseJson(await readStdin())
  if (hookInput.tool_name && hookInput.tool_name !== 'AskUserQuestion') return

  const hookSession = hookInput.session_id ? String(hookInput.session_id) : ''
  const validation = validateActiveLoopState({
    statePath: LOOP_STATE_FILE,
    historyPath: LOOP_HISTORY_FILE,
    hookSession,
    source: 'ask-user-question',
  })
  if (!validation.ok) {
    return
  }
  const { state } = validation

  const {
    clone_threshold: cloneThresholdRaw,
    clone_agent: cloneAgentRaw,
    clone_session_id: cloneSessionId,
    mcp_session_id: mcpSessionIdInitial,
  } = state.frontmatter

  const toolInput = hookInput.tool_input || {}
  const questions = Array.isArray(toolInput.questions) ? toolInput.questions : []
  if (!questions.length) return

  const cloneThreshold = cloneThresholdRaw || '0.6'
  const cloneAgent = cloneAgentRaw || 'Claude Code Clone Loop'
  const answers = {}
  const confidenceValues = []

  for (const [questionIndex, question] of questions.entries()) {
    if (question?.multiSelect) {
      appendHistory({ event: 'ask-user-question', decision: 'defer-multiselect' })
      return
    }

    const options = Array.isArray(question?.options) ? question.options : []
    const questionText = String(question?.question || '').trim()
    if (!questionText || !options.length) {
      appendHistory({ event: 'ask-user-question', decision: 'defer-invalid-question' })
      return
    }

    let prediction
    try {
      prediction = await clonePredictNextPrompt({
        agent: cloneAgent,
        agentInput: buildQuestionAgentInput({
          state,
          question,
          questionIndex,
          questionCount: questions.length,
          threshold: cloneThreshold,
          transcriptPath: hookInput.transcript_path ? String(hookInput.transcript_path) : '',
          historyPath: LOOP_HISTORY_FILE,
        }),
        threshold: cloneThreshold,
        sessionId: cloneSessionId || undefined,
        mcpSessionId: mcpSessionIdInitial,
      })
    } catch (error) {
      const fallbackAnswer = String(options[0]?.label || '').trim()
      if (fallbackAnswer) {
        answers[questionText] = fallbackAnswer
        confidenceValues.push(0)
        appendHistory({
          event: 'ask-user-question',
          decision: 'auto-answer-fallback-mcp-error',
          question: questionText,
          answer: fallbackAnswer,
          error: error?.message || String(error),
        })
        continue
      }

      appendHistory({
        event: 'ask-user-question',
        decision: 'defer-mcp-error',
        question: questionText,
        error: error?.message || String(error),
      })
      return
    }

    const predictedResponse = String(prediction?.predicted_response || '').trim()
    const selection = predictedResponse
      ? {
          answer: predictedResponse,
          confidence: numericConfidence(prediction.confidence, 0),
          text: predictedResponse,
          freeform: true,
        }
      : chooseHighestConfidenceOption(prediction, options)

    if (!selection.answer) {
      appendHistory({
        event: 'ask-user-question',
        decision: 'defer-no-options',
        question: questionText,
        threshold: Number(cloneThreshold),
        prediction_id: prediction.id || null,
        status: prediction.status || null,
      })
      await safeReject({ predictionId: prediction.id, mcpSessionId: mcpSessionIdInitial })
      return
    }

    answers[questionText] = selection.answer
    confidenceValues.push(selection.confidence)
  }

  const confidence = Math.min(...confidenceValues)
  appendHistory({
    event: 'ask-user-question',
    decision: 'auto-answer-freeform',
    confidence,
    threshold: Number(cloneThreshold),
    answers,
  })
  allowAnswer({ toolInput, answers, confidence, threshold: cloneThreshold })
}

main().catch((error) => {
  appendHistory({
    event: 'ask-user-question',
    decision: 'defer-unhandled-error',
    error: error?.message || String(error),
  })
})
