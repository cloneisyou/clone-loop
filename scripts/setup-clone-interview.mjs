#!/usr/bin/env node

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const args = process.argv.slice(2)
const topicParts = []
let maxQuestions = '12'
let mode = 'deep'
let outputPath = '.claude/clone-interview.local.md'
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

function quoteYaml(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function isPositiveInteger(value) {
  return /^[1-9][0-9]*$/.test(String(value || ''))
}

function isThreshold(value) {
  return /^(0(\.[0-9]+)?|1(\.0+)?)$/.test(value)
}

function projectLocalPath(path) {
  const root = process.cwd()
  const resolved = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    fail(`Error: --output must stay inside the current project. Received: ${path}`)
  }
  return { resolved, display: rel || '.' }
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
const claudeDir = resolve(root, '.claude')
mkdirSync(claudeDir, { recursive: true })

const statePath = resolve(claudeDir, 'clone-interview.local.md')
const historyPath = resolve(claudeDir, 'clone-interview.history.local.jsonl')
const output = projectLocalPath(outputPath)
mkdirSync(dirname(output.resolved), { recursive: true })

const startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
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

- (Record explicit user decisions here.)

### Scope

- (Record in-scope behavior here.)

### Non-Goals

- (Record out-of-scope behavior here.)

### Constraints

- (Record technical, product, timeline, privacy, and compatibility constraints here.)

### Acceptance Criteria

- (Record observable completion criteria here.)

### Verification

- (Record required tests, checks, demos, or review gates here.)

### Restated Goal

- (Before closing, restate the final one-sentence goal and get user confirmation.)

## Interview Operating Rules

- Inspect code first for factual questions about stack, existing patterns, and file structure.
- Auto-confirm only exact repo facts, and mark them with \`[from-code][auto-confirmed]\`.
- Before asking human-judgment questions, ask Clone to predict the user's answer when \`auto_answer\` is true.
- Use Clone-predicted answers only when confidence is greater than or equal to \`clone_threshold\`; otherwise escalate to the user.
- Ask the user for goals, scope, acceptance criteria, product tradeoffs, business logic, and non-goals.
- Ask one question at a time.
- Structure free-form answers that carry scope or constraints, then confirm nothing was lost before treating them as final.
- In \`quick\` mode, close goal, output, and acceptance criteria.
- In \`deep\` mode, close goal, audience, constraints, outputs, acceptance criteria, non-goals, and verification.
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
