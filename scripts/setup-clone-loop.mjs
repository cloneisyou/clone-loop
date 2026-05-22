#!/usr/bin/env node

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { formatIterationPromptLine } from './clone-display.mjs'
import { claudeDir, loopHistoryPath, loopStatePath } from './clone-paths.mjs'
import { isIntegerString, isThreshold, nowIso, quoteYaml } from './clone-utils.mjs'
import { recordAgentPrompt, startCloneSession } from './clone-mcp.mjs'

const args = process.argv.slice(2)
const promptParts = []
let maxIterations = '0'
let cloneThreshold = '0.6'
let cloneAgent = process.env.CODEX_THREAD_ID ? 'Codex Clone Loop' : 'Claude Code Clone Loop'

function usage() {
  console.log(`Clone Loop - iterative development loop with Clone-predicted next prompts

USAGE:
  /clone:loop [PROMPT...] [OPTIONS]

ARGUMENTS:
  PROMPT...    Initial Clone Loop task prompt.

OPTIONS:
  --max-iterations <n>       Maximum iterations before auto-stop (default: unlimited)
  --clone-threshold <n>      Clone auto/escalation threshold in [0, 1] (default: 0.6)
  --clone-agent '<text>'     Agent label sent to Clone (default: current runtime Clone Loop)
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

for (let index = 0; index < args.length;) {
  const arg = args[index]
  if (arg === '-h' || arg === '--help') {
    usage()
    process.exit(0)
  }

  if (arg === '--max-iterations') {
    const value = args[index + 1]
    if (!value || !isIntegerString(value)) {
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
const root = process.cwd()
mkdirSync(claudeDir(root), { recursive: true })

const startedAt = nowIso()
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

const statePath = loopStatePath(root)
writeFileSync(statePath, state)

try {
  appendFileSync(
    loopHistoryPath(root),
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

async function bootstrapCloneSession() {
  if (String(process.env.CLONE_LOOP_DISABLE_SESSION || '').trim() === '1') return
  try {
    const { cloneSessionId, mcpSessionId } = await startCloneSession({
      sourceDetail: 'clone:loop',
    })
    const recorded = await recordAgentPrompt({
      cloneSessionId,
      mcpSessionId,
      agent: cloneAgent,
      prompt,
      source: 'user',
      sourceDetail: 'clone-loop:iteration-1',
    })
    const promptEventId = recorded?.eventId || ''

    let content = readFileSync(statePath, 'utf8')
    const insert = []
    if (cloneSessionId) insert.push(`clone_session_id: ${quoteYaml(cloneSessionId)}`)
    if (mcpSessionId) insert.push(`mcp_session_id: ${quoteYaml(mcpSessionId)}`)
    if (promptEventId) insert.push(`last_prompt_event_id: ${quoteYaml(promptEventId)}`)
    if (insert.length) {
      content = content.replace(/^started_at: .*$/m, (match) => `${match}\n${insert.join('\n')}`)
      writeFileSync(statePath, content)
    }
    appendFileSync(
      loopHistoryPath(root),
      `${JSON.stringify({
        ts: nowIso(),
        event: 'session-started',
        clone_session_id: cloneSessionId,
        mcp_session_id: mcpSessionId,
        prompt_event_id: promptEventId,
      })}\n`,
    )
  } catch (error) {
    console.error(
      `Clone Loop: Clone MCP session bootstrap failed; continuing without session context. (${error?.message || String(error)})`,
    )
  }
}

await bootstrapCloneSession()

console.log(`${formatIterationPromptLine({ iteration: 1, prompt })}

Clone Loop activated.

Max iterations: ${Number(maxIterations) > 0 ? maxIterations : 'unlimited'}
Clone threshold: ${cloneThreshold}
Clone agent: ${cloneAgent}

The stop hook is active. On each stop, the agent will ask Clone MCP to predict
the next user prompt and continue only when confidence clears the threshold.

To monitor: head -10 .claude/clone-loop.local.md`)
