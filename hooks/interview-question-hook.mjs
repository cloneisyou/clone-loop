#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { loopStatePath } from '../scripts/clone-paths.mjs'
import { parseJson, readStdin } from '../scripts/clone-utils.mjs'
import { predictInterviewAnswer } from '../scripts/predict-interview-answer.mjs'

function allowAnswer({ toolInput, answers, confidence, threshold }) {
  console.log(
    JSON.stringify(
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `Clone Interview answered with Clone-predicted response. Confidence ${confidence}; threshold ${threshold}.`,
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

function answerKind(question) {
  return Array.isArray(question?.options) && question.options.length ? 'choice' : 'freeform'
}

async function main() {
  const hookInput = parseJson(await readStdin())
  if (hookInput.tool_name && hookInput.tool_name !== 'AskUserQuestion') return

  // Clone Loop owns AskUserQuestion while an active loop state exists.
  if (existsSync(loopStatePath())) return

  const toolInput = hookInput.tool_input || {}
  const questions = Array.isArray(toolInput.questions) ? toolInput.questions : []
  if (!questions.length) return

  const answers = {}
  const confidences = []
  let threshold = 0.75

  for (const question of questions) {
    if (question?.multiSelect) return
    const questionText = String(question?.question || '').trim()
    if (!questionText) return

    const result = await predictInterviewAnswer({
      cwd: process.cwd(),
      session_id: hookInput.session_id || '',
      transcript_path: hookInput.transcript_path || '',
      last_assistant_message: hookInput.last_assistant_message || '',
      question: questionText,
      options: Array.isArray(question.options) ? question.options : [],
      answer_kind: answerKind(question),
    })
    if (result.decision !== 'auto' || !result.answer) return

    answers[questionText] = result.answer
    confidences.push(Number(result.confidence) || 0)
    threshold = Number(result.threshold) || threshold
  }

  allowAnswer({
    toolInput,
    answers,
    confidence: Math.min(...confidences),
    threshold,
  })
}

main().catch(() => {})
