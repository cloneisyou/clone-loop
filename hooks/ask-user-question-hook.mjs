#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loopHistoryPath, loopStatePath } from '../scripts/clone-paths.mjs'
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
import { cloneMcpClientInfo, cloneMcpEndpoint, cloneMcpRpc } from '../scripts/clone-mcp-client.mjs'
import { numeric, parseJson, readStdin } from '../scripts/clone-utils.mjs'
import { mapPredictionToOption, rankedPredictionCandidates } from '../scripts/interview-answer-utils.mjs'

const LOOP_STATE_FILE = loopStatePath()
const LOOP_HISTORY_FILE = loopHistoryPath()

function appendHistory(record) {
  appendLoopHistory(LOOP_HISTORY_FILE, record)
}

async function clonePredictNextPrompt({ agent, agentInput, threshold, sessionId }) {
  const endpoint = cloneMcpEndpoint()
  const { token } = resolveCloneToken()

  const init = await cloneMcpRpc(endpoint, token, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: cloneMcpClientInfo(),
  })

  const args = {
    agent,
    agent_input: agentInput,
    k: 1,
    threshold: Number(threshold || '0.6'),
  }
  if (sessionId) args.session_id = sessionId

  const prediction = await cloneMcpRpc(
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

function numericConfidence(value, fallback = 0) {
  return numeric(value, fallback)
}

function chooseHighestConfidenceOption(prediction, options) {
  const labels = options.map((option) => String(option?.label || '').trim()).filter(Boolean)
  const rankedCandidates = rankedPredictionCandidates(prediction)
  const mapped = []

  for (const candidate of rankedCandidates) {
    const answer = mapPredictionToOption(candidate.text, options, null)
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
