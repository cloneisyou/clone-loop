#!/usr/bin/env node

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const promptParts = []
let maxIterations = '0'
let cloneThreshold = '0.6'
let cloneAgent = process.env.CODEX_THREAD_ID ? 'Codex Clone Loop' : 'Claude Code Clone Loop'
const ANSI_BOLD = '\u001b[1m'
const ANSI_PURPLE = '\u001b[35m'
const ANSI_RESET = '\u001b[0m'

function usage() {
  console.log(`Clone Loop - iterative development loop with Clone-predicted next prompts

USAGE:
  /clone:loop [PROMPT...] [OPTIONS]

ARGUMENTS:
  PROMPT...    Initial Clone Loop task prompt.

OPTIONS:
  --max-iterations <n>       Maximum iterations before auto-stop (default: unlimited)
  --clone-threshold <n>      Clone auto/escalation threshold in [0, 1] (default: 0.6)
  --clone-agent '<text>'     Agent label sent to Clone (default: Claude Code Clone Loop)
  -h, --help                 Show this help message

DESCRIPTION:
  Starts a Clone Loop in your current session. The stop hook prevents exit,
  asks Clone MCP to predict the next user prompt, and continues only when
  Clone is confident enough.

EXAMPLES:
  /clone:loop Build a todo API --max-iterations 20
  /clone:loop Fix the auth bug --max-iterations 10 --clone-threshold 0.75
  /clone:loop Refactor cache layer --clone-agent "Claude Code Clone Loop"`)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function isThreshold(value) {
  return /^(0(\.[0-9]+)?|1(\.0+)?)$/.test(value)
}

function quoteYaml(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function purple(value) {
  return `${ANSI_PURPLE}${value}${ANSI_RESET}`
}

function purpleBold(value) {
  return `${ANSI_BOLD}${ANSI_PURPLE}${value}${ANSI_RESET}`
}

function formatIterationPromptLine({ iteration, prompt }) {
  const [firstLine = '', ...remainingLines] = String(prompt || '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
  const continuation = remainingLines.length
    ? `\n${remainingLines.map((line) => purpleBold(`> ${line}`)).join('\n')}`
    : ''
  return `${purpleBold(`Iteration ${iteration} : ${firstLine}`)}${continuation}`
}

for (let index = 0; index < args.length;) {
  const arg = args[index]
  if (arg === '-h' || arg === '--help') {
    usage()
    process.exit(0)
  }

  if (arg === '--max-iterations') {
    const value = args[index + 1]
    if (!value || !/^[0-9]+$/.test(value)) {
      fail('Error: --max-iterations requires a positive integer or 0.')
    }
    maxIterations = value
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

  if (arg.startsWith('--')) {
    fail(`Error: Unknown option ${arg}.`)
  }

  promptParts.push(arg)
  index += 1
}

const prompt = promptParts.join(' ')
if (!prompt) {
  fail('Error: No prompt provided.\nExample: /clone:loop Build a REST API for todos --max-iterations 20')
}

const sessionId = process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || ''
const claudeDir = join(process.cwd(), '.claude')
mkdirSync(claudeDir, { recursive: true })

const startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const state = `---
active: true
iteration: 1
session_id: ${sessionId}
max_iterations: ${maxIterations}
clone_threshold: ${cloneThreshold}
clone_agent: ${quoteYaml(cloneAgent)}
started_at: "${startedAt}"
---

${prompt}
`

writeFileSync(join(claudeDir, 'clone-loop.local.md'), state)

try {
  appendFileSync(
    join(claudeDir, 'clone-loop.history.local.jsonl'),
    `${JSON.stringify({
      ts: startedAt,
      event: 'loop-start',
      session_id: sessionId,
      max_iterations: Number(maxIterations),
      clone_threshold: Number(cloneThreshold),
      clone_agent: cloneAgent,
      prompt,
    })}\n`,
  )
} catch {}

console.log(`${formatIterationPromptLine({ iteration: 1, prompt })}

Clone Loop activated.

Max iterations: ${Number(maxIterations) > 0 ? maxIterations : 'unlimited'}
Clone threshold: ${cloneThreshold}
Clone agent: ${cloneAgent}

The stop hook is active. On each stop, Claude will ask Clone MCP to predict
the next user prompt and continue only when confidence clears the threshold.

To monitor: head -10 .claude/clone-loop.local.md`)
