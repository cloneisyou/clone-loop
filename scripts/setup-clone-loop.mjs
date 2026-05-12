#!/usr/bin/env node

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const promptParts = []
let maxIterations = '0'
let completionPromise = null
let cloneThreshold = '0.8'
let cloneK = '1'
let cloneAgent = 'Claude Code Clone Loop'

function usage() {
  console.log(`Clone Loop - iterative development loop with Clone-predicted next prompts

USAGE:
  /clone:loop [PROMPT...] [OPTIONS]

ARGUMENTS:
  PROMPT...    Initial Clone Loop task prompt.

OPTIONS:
  --max-iterations <n>           Maximum iterations before auto-stop (default: unlimited)
  --completion-promise '<text>'  Promise phrase that signals genuine completion
  --clone-threshold <n>          Clone auto/escalation threshold in [0, 1] (default: 0.8)
  --clone-k <n>                  Number of Clone candidate prompts to request, 1-10 (default: 1)
  --clone-agent '<text>'         Agent label sent to Clone (default: Claude Code Clone Loop)
  -h, --help                     Show this help message

DESCRIPTION:
  Starts a Clone Loop in your current session. The stop hook prevents exit,
  asks Clone MCP to predict the next user prompt, and continues only when
  Clone is confident enough.

  To signal completion, output: <promise>YOUR_PHRASE</promise>

EXAMPLES:
  /clone:loop Build a todo API --completion-promise DONE --max-iterations 20
  /clone:loop Fix the auth bug --max-iterations 10 --clone-threshold 0.75
  /clone:loop Refactor cache layer --clone-k 3`)
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

  if (arg === '--completion-promise') {
    const value = args[index + 1]
    if (!value) fail('Error: --completion-promise requires text.')
    completionPromise = value
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

  if (arg === '--clone-k') {
    const value = args[index + 1]
    if (!value || !/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 10) {
      fail('Error: --clone-k must be an integer from 1 to 10.')
    }
    cloneK = value
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

  promptParts.push(arg)
  index += 1
}

const prompt = promptParts.join(' ')
if (!prompt) {
  fail('Error: No prompt provided.\nExample: /clone:loop Build a REST API for todos --max-iterations 20')
}

const claudeDir = join(process.cwd(), '.claude')
mkdirSync(claudeDir, { recursive: true })

const startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const completionPromiseYaml = completionPromise ? quoteYaml(completionPromise) : 'null'
const state = `---
active: true
iteration: 1
session_id: ${process.env.CLAUDE_CODE_SESSION_ID || ''}
max_iterations: ${maxIterations}
completion_promise: ${completionPromiseYaml}
clone_threshold: ${cloneThreshold}
clone_k: ${cloneK}
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
      session_id: process.env.CLAUDE_CODE_SESSION_ID || '',
      max_iterations: Number(maxIterations),
      clone_threshold: Number(cloneThreshold),
      clone_k: Number(cloneK),
      clone_agent: cloneAgent,
      completion_promise: completionPromise,
      prompt,
    })}\n`,
  )
} catch {}

console.log(`Clone Loop activated.

Iteration: 1
Max iterations: ${Number(maxIterations) > 0 ? maxIterations : 'unlimited'}
Completion promise: ${completionPromise || 'none'}
Clone threshold: ${cloneThreshold}
Clone k: ${cloneK}
Clone agent: ${cloneAgent}

The stop hook is active. On each stop, Claude will ask Clone MCP to predict
the next user prompt and continue only when confidence clears the threshold.

To monitor: head -10 .claude/clone-loop.local.md`)

console.log(`\n${prompt}`)

if (completionPromise) {
  console.log(`
CRITICAL - Clone Loop Completion Promise

To complete this loop, output this EXACT text:
  <promise>${completionPromise}</promise>

Only output it when the statement is completely and unequivocally true.
Do not output a false promise to escape the loop.`)
}
