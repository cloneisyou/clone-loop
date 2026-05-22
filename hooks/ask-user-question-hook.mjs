#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
  validateActiveLoopState,
} from '../scripts/loop-state-guard.mjs'
import { clonePredictNextPrompt, recordAgentPrompt, submitFeedback } from '../scripts/clone-mcp.mjs'
import { numeric, parseJson, readStdin } from '../scripts/clone-utils.mjs'
import { mapPredictionToOption, rankedPredictionCandidates } from '../scripts/interview-answer-utils.mjs'

const LOOP_STATE_FILE = loopStatePath()
const LOOP_HISTORY_FILE = loopHistoryPath()

function appendHistory(record) {
  appendLoopHistory(LOOP_HISTORY_FILE, record)
}

function numericConfidence(value, fallback = 0) {
  return numeric(value, fallback)
}

function chooseHighestConfidenceOption(prediction, options) {
  const rankedCandidates = rankedPredictionCandidates(prediction)
  const mapped = []

  for (const candidate of rankedCandidates) {
    const answer = mapPredictionToOption(candidate.text, options, null)
    if (!answer) continue
    mapped.push({ ...candidate, answer })
  }

  if (mapped.length) return mapped[0]
  return null
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
          permissionDecisionReason: `Clone answered AskUserQuestion with a predicted response. Confidence ${confidence}; threshold ${threshold}.`,
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

function deferQuestion({ decision, question, threshold, prediction, confidence, error }) {
  appendHistory({
    event: 'ask-user-question',
    decision,
    question,
    threshold: Number(threshold),
    confidence: confidence == null ? null : Number(confidence),
    prediction_id: prediction?.id || null,
    status: prediction?.status || null,
    error: error ? error?.message || String(error) : undefined,
  })
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

async function safeFeedback({ predictionId, status, mcpSessionId }) {
  if (!predictionId) return
  try {
    await submitFeedback({ predictionId, status, mcpSessionId })
    appendHistory({ event: 'feedback-sent', source: 'ask-user-question', prediction_id: predictionId, status })
  } catch (error) {
    appendHistory({ event: 'feedback-sent', source: 'ask-user-question', prediction_id: predictionId, status, error: error?.message || String(error) })
  }
}

async function safeReject({ predictionId, mcpSessionId }) {
  await safeFeedback({ predictionId, status: 'rejected', mcpSessionId })
}

async function safeRecordAnswer({ cloneSessionId, mcpSessionId, agent, question, answer, iteration }) {
  if (!cloneSessionId || !answer) return null
  try {
    const result = await recordAgentPrompt({
      cloneSessionId,
      mcpSessionId,
      agent,
      prompt: `Q: ${question}\nA: ${answer}`,
      source: 'auto-answer',
      sourceDetail: `clone-loop:ask-user-question:iteration-${iteration || 'unknown'}`,
    })
    appendHistory({
      event: 'record-prompt',
      source: 'ask-user-question',
      event_id: result?.eventId || null,
    })
    return result
  } catch (error) {
    appendHistory({
      event: 'record-prompt',
      source: 'ask-user-question',
      error: error?.message || String(error),
    })
    return null
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
    iteration,
  } = state.frontmatter

  const toolInput = hookInput.tool_input || {}
  const questions = Array.isArray(toolInput.questions) ? toolInput.questions : []
  if (!questions.length) return

  const cloneThreshold = cloneThresholdRaw || '0.6'
  const cloneAgent = cloneAgentRaw || 'Claude Code Clone Loop'
  const answers = {}
  const acceptedPredictions = []
  const confidenceValues = []
  let activeMcpSessionId = mcpSessionIdInitial || ''

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
        mcpSessionId: activeMcpSessionId,
      })
    } catch (error) {
      deferQuestion({
        decision: 'defer-mcp-error',
        question: questionText,
        threshold: cloneThreshold,
        error,
      })
      return
    }

    if (prediction?.status !== 'auto') {
      deferQuestion({
        decision: 'defer-non-auto',
        question: questionText,
        threshold: cloneThreshold,
        prediction,
        confidence: prediction.confidence,
      })
      await safeReject({ predictionId: prediction.id, mcpSessionId: activeMcpSessionId })
      return
    }

    if (prediction.mcp_session_id && prediction.mcp_session_id !== activeMcpSessionId) {
      activeMcpSessionId = prediction.mcp_session_id
      const updated = updateFrontmatter(readFileSync(LOOP_STATE_FILE, 'utf8'), 'mcp_session_id', activeMcpSessionId)
      writeFileSync(LOOP_STATE_FILE, updated)
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

    if (!selection?.answer) {
      deferQuestion({
        decision: 'defer-unmapped',
        question: questionText,
        threshold: cloneThreshold,
        prediction,
        confidence: prediction?.confidence,
      })
      await safeReject({ predictionId: prediction?.id, mcpSessionId: activeMcpSessionId })
      return
    }

    if (!(Number.isFinite(Number(selection.confidence)) && Number(selection.confidence) >= Number(cloneThreshold))) {
      deferQuestion({
        decision: 'defer-low-confidence',
        question: questionText,
        threshold: cloneThreshold,
        prediction,
        confidence: selection.confidence,
      })
      await safeReject({ predictionId: prediction.id, mcpSessionId: activeMcpSessionId })
      return
    }

    answers[questionText] = selection.answer
    acceptedPredictions.push({
      predictionId: prediction.id || '',
      question: questionText,
      answer: selection.answer,
    })
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
  for (const accepted of acceptedPredictions) {
    await safeFeedback({
      predictionId: accepted.predictionId,
      status: 'accepted',
      mcpSessionId: activeMcpSessionId,
    })
    const recorded = await safeRecordAnswer({
      cloneSessionId,
      mcpSessionId: activeMcpSessionId,
      agent: cloneAgent,
      question: accepted.question,
      answer: accepted.answer,
      iteration,
    })
    if (recorded?.eventId) {
      const updated = updateFrontmatter(
        readFileSync(LOOP_STATE_FILE, 'utf8'),
        'last_prompt_event_id',
        recorded.eventId,
      )
      writeFileSync(LOOP_STATE_FILE, updated)
    }
  }
  allowAnswer({ toolInput, answers, confidence, threshold: cloneThreshold })
}

main().catch((error) => {
  appendHistory({
    event: 'ask-user-question',
    decision: 'defer-unhandled-error',
    error: error?.message || String(error),
  })
})
