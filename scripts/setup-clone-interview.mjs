#!/usr/bin/env node

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_INTERVIEW_OUTPUT_PATH,
  claudeDir,
  interviewHistoryPath,
  interviewStatePath,
  projectLocalPath as resolveProjectLocalPath,
} from './clone-paths.mjs'
import { isPositiveInteger, isThreshold, nowIso, quoteYaml } from './clone-utils.mjs'

const args = process.argv.slice(2)
const topicParts = []
let maxQuestions = '12'
let mode = 'deep'
let outputPath = DEFAULT_INTERVIEW_OUTPUT_PATH
let cloneThreshold = '0.75'
let cloneAgent = process.env.CODEX_THREAD_ID ? 'Codex Clone Interview' : 'Claude Code Clone Interview'
let autoAnswer = true

function usage() {
  console.log(`Clone Interview - clarify requirements into a local spec

USAGE:
  /clone:interview [TOPIC...] [OPTIONS]

ARGUMENTS:
  TOPIC...    Feature, product idea, bug, or workflow to clarify.

OPTIONS:
  --max-questions <n>    Maximum interview questions before restating (default: 12)
  --mode <quick|deep>    Interview depth (default: deep)
  --output <path>        Markdown spec path (default: .claude/clone-interview.local.md)
  --clone-threshold <n>  Confidence threshold for Clone auto-answers (default: 0.75)
  --clone-agent <text>   Agent label sent to Clone (default: Claude Code Clone Interview)
  --no-auto-answer       Disable Clone-predicted interview answers
  -h, --help             Show this help message

DESCRIPTION:
  Starts a Clone Interview in the current project. The agent should inspect
  repo facts first, ask one human-judgment question at a time, and maintain
  the generated markdown as the working spec.

EXAMPLES:
  /clone:interview Add billing to the app
  /clone:interview Improve onboarding --mode quick --max-questions 5
  /clone:interview Build importer --output docs/clone-interview/importer.md`)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function projectLocalPath(path) {
  const root = process.cwd()
  const localPath = resolveProjectLocalPath(root, path)
  if (!localPath.isInsideProject) {
    fail(`Error: --output must stay inside the current project. Received: ${path}`)
  }
  return localPath
}

for (let index = 0; index < args.length;) {
  const arg = args[index]
  if (arg === '-h' || arg === '--help') {
    usage()
    process.exit(0)
  }

  if (arg === '--max-questions') {
    const value = args[index + 1]
    if (!isPositiveInteger(value)) {
      fail('Error: --max-questions requires a positive integer.')
    }
    maxQuestions = value
    index += 2
    continue
  }

  if (arg === '--mode') {
    const value = String(args[index + 1] || '').trim()
    if (!['quick', 'deep'].includes(value)) {
      fail('Error: --mode must be quick or deep.')
    }
    mode = value
    index += 2
    continue
  }

  if (arg === '--output') {
    const value = String(args[index + 1] || '').trim()
    if (!value) fail('Error: --output requires a path.')
    outputPath = value
    index += 2
    continue
  }

  if (arg === '--clone-threshold') {
    const value = args[index + 1]
    if (!value || !isThreshold(value)) {
      fail('Error: --clone-threshold must be a number in [0, 1].')
    }
    cloneThreshold = value
    index += 2
    continue
  }

  if (arg === '--clone-agent') {
    const value = args[index + 1]
    if (!value) fail('Error: --clone-agent requires text.')
    cloneAgent = value
    index += 2
    continue
  }

  if (arg === '--no-auto-answer') {
    autoAnswer = false
    index += 1
    continue
  }

  if (arg.startsWith('--')) {
    fail(`Error: Unknown option ${arg}.`)
  }

  topicParts.push(arg)
  index += 1
}

const topic = topicParts.join(' ').trim()
if (!topic) {
  fail('Error: No topic provided.\nExample: /clone:interview Add billing to the app --mode deep')
}

const root = process.cwd()
mkdirSync(claudeDir(root), { recursive: true })

const statePath = interviewStatePath(root)
const historyPath = interviewHistoryPath(root)
const output = projectLocalPath(outputPath)
mkdirSync(dirname(output.resolved), { recursive: true })

const startedAt = nowIso()
const sessionId = process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || ''
const spec = `---
active: true
topic: ${quoteYaml(topic)}
mode: ${quoteYaml(mode)}
max_questions: ${maxQuestions}
question_count: 0
session_id: ${quoteYaml(sessionId)}
clone_threshold: ${cloneThreshold}
clone_agent: ${quoteYaml(cloneAgent)}
auto_answer: ${autoAnswer ? 'true' : 'false'}
started_at: ${quoteYaml(startedAt)}
output_path: ${quoteYaml(output.display.replace(/\\/g, '/'))}
---

# Clone Interview

## Topic

${topic}

## Working Ledger

### Code Facts

- (Agent should inspect repository facts before asking user-judgment questions.)

### User Decisions

- (Record explicit user decisions here as \`[from-user] ...\`.)

### Clone Predictions

- (Record high-confidence Clone answers as \`[from-clone][auto] ...\`.)
- (Record low-confidence suggestions as \`[from-clone][escalated] ...\` before asking the user.)

## Goal Contract

### Why

- (Why this goal matters to the user or business.)

### Desired Outcome

- (The concrete end state the user wants.)

### Target User

- (Who the work is for.)

### In Scope

- (Behaviors, surfaces, or deliverables this plan should include.)

### Out of Scope

- (Explicit non-goals and deferred work.)

### Decision Boundaries

- (What the agent may decide without confirmation, and what must go back to the user.)

### Constraints

- (Technical, product, timeline, privacy, compatibility, or launch constraints.)

### Acceptance Criteria

- [ ] (Observable, testable completion criterion.)

## Decision Ledger

| Source | Decision | Plan Impact |
| --- | --- | --- |
| \`[from-code][auto-confirmed]\` | (descriptive repo fact) | (how it shapes the plan) |
| \`[from-user]\` | (user decision) | (how it changes scope, tests, or implementation) |
| \`[from-clone][auto]\` | (Clone-predicted answer accepted above threshold) | (how it changes the plan draft) |
| \`[from-clone][escalated]\` | (low-confidence suggestion) | (question asked to the user before relying on it) |

## Plan Draft

### Implementation Phases

1. (Phase name and goal.)

### Likely Touched Areas

- (Files, directories, modules, commands, docs, or config likely affected.)

### Required Tests / Checks

- (Record required tests, checks, demos, or review gates here.)

### Risks and Unknowns

- (Risks, unclear decisions, or assumptions that could change execution.)

### Acceptance Checklist

- [ ] (Checklist item tied to the acceptance criteria.)

## Readiness Audit

- [ ] One-sentence goal is unambiguous.
- [ ] In-scope and out-of-scope are separated.
- [ ] Acceptance criteria are observable or testable.
- [ ] Product/business decisions are resolved or listed as open questions.
- [ ] Plan Draft includes phase, likely touched areas, tests/checks, and risks.

## Execution Handoff

- (After the Readiness Audit passes, ask the user to choose: Refine plan, Start Clone Loop with this plan, Implement manually from this plan, or Stop here.)

## Interview Operating Rules

- Inspect code first for factual questions about stack, existing patterns, and file structure.
- Auto-confirm only exact repo facts, and mark them with \`[from-code][auto-confirmed]\`.
- Before asking human-judgment questions, ask Clone to predict the user's answer when \`auto_answer\` is true.
- Use Clone-predicted answers only when confidence is greater than or equal to \`clone_threshold\`; otherwise escalate to the user.
- Ask the highest-impact unresolved question in this order: goal, outcome, scope/non-goals, decision boundaries, constraints, acceptance criteria, plan risks.
- Ask one question at a time using this frame: Current understanding, Blocked decision, Clone predicted answer or escalation, Question, Plan impact.
- Update the Goal Contract, Decision Ledger, Plan Draft, and Readiness Audit after every answer, including Clone auto-answers.
- In \`quick\` mode, close goal, outcome, scope, acceptance criteria, and a minimal Plan Draft.
- In \`deep\` mode, close goal, audience, decision boundaries, constraints, non-goals, acceptance criteria, risks, and Execution Handoff.
- Before closing, run the Readiness Audit. If any item fails, ask the single question that would most improve the plan.
`

writeFileSync(statePath, spec)
if (output.resolved !== statePath) {
  writeFileSync(output.resolved, spec)
}

appendFileSync(
  historyPath,
  `${JSON.stringify({
    ts: startedAt,
    event: 'interview-start',
    topic,
    mode,
    max_questions: Number(maxQuestions),
    session_id: sessionId,
    clone_threshold: Number(cloneThreshold),
    clone_agent: cloneAgent,
    auto_answer: autoAnswer,
    output_path: output.display.replace(/\\/g, '/'),
  })}\n`,
)

console.log(`Clone Interview started.

Topic: ${topic}
Mode: ${mode}
Max questions: ${maxQuestions}
Clone threshold: ${cloneThreshold}
Auto-answer: ${autoAnswer ? 'enabled' : 'disabled'}
Spec: ${output.display.replace(/\\/g, '/')}
State: .claude/clone-interview.local.md

Next: inspect repo facts, then ask the first human-judgment question.`)
