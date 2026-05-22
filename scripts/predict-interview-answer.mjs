#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { interviewHistoryPath, interviewStatePath } from './clone-paths.mjs'
import { resolveCloneToken } from './clone-auth.mjs'
import { cloneMcpClientInfo, cloneMcpEndpoint, cloneMcpRpc } from './clone-mcp-client.mjs'
import { numeric, parseJson, readStdin } from './clone-utils.mjs'
import { mapPredictionToOption, rankedPredictionCandidates } from './interview-answer-utils.mjs'
import { appendLoopHistory, parseState } from './loop-state-guard.mjs'

async function submitFeedback({ endpoint, token, predictionId, status, actualResponse, mcpSessionId }) {
  if (!predictionId) return
  const args = { prediction_id: predictionId, status }
  if (actualResponse) args.actual_response = actualResponse
  await cloneMcpRpc(endpoint, token, 'tools/call', { name: 'submit_feedback', arguments: args }, mcpSessionId)
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
    k: 3,
    threshold: Number(threshold || '0.75'),
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
  return {
    endpoint,
    token,
    mcpSessionId: prediction.sessionId || init.sessionId,
    prediction: JSON.parse(content.text),
  }
}

function historyPath(root) {
  return interviewHistoryPath(root)
}

function statePath(root) {
  return interviewStatePath(root)
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

Current Clone Interview spec:
${spec || '(empty spec)'}

Pay special attention to these sections when present:
- Goal Contract: what goal, outcome, scope, non-goals, decision boundaries, constraints, and acceptance criteria are already settled.
- Decision Ledger: which decisions came from code, user, Clone auto-answer, or Clone escalation.
- Plan Draft: what implementation phases, likely touched areas, tests/checks, risks, and acceptance checklist are emerging.
- Readiness Audit: what gap this question should close before execution handoff.

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
- Preserve concrete scope, constraints, non-goals, decision boundaries, acceptance criteria, and plan impact.
- If options are provided and one clearly matches, answer with that option label.
- If confidence is low, still return the best prediction; the caller will escalate.`
}

function selectAnswer({ prediction, answerKind, options }) {
  const ranked = rankedPredictionCandidates(prediction)
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
