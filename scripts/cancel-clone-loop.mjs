#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { loopHistoryPath, loopStatePath } from './clone-paths.mjs'
import { appendLoopHistory, parseState, removeLoopState } from './loop-state-guard.mjs'
import { stopCloneSession } from './clone-mcp.mjs'

const root = process.cwd()
const statePath = loopStatePath(root)
const historyPath = loopHistoryPath(root)

if (!existsSync(statePath)) {
  console.log('No active Clone Loop found.')
  process.exit(0)
}

let iteration = 'unknown'
let cloneSessionId = ''
let mcpSessionId = ''
try {
  const state = parseState(readFileSync(statePath, 'utf8'))
  iteration = state?.frontmatter?.iteration || iteration
  cloneSessionId = state?.frontmatter?.clone_session_id || ''
  mcpSessionId = state?.frontmatter?.mcp_session_id || ''
} catch {}

if (cloneSessionId) {
  try {
    await stopCloneSession({
      cloneSessionId,
      mcpSessionId,
      sourceDetail: 'clone-loop:cancel',
    })
    appendLoopHistory(historyPath, {
      event: 'session-stopped',
      reason: 'cancel',
      clone_session_id: cloneSessionId,
    })
  } catch (error) {
    console.error(
      `Clone Loop: Failed to stop Clone session (${error?.message || String(error)}); removing state anyway.`,
    )
  }
}

removeLoopState(statePath)
appendLoopHistory(historyPath, {
  event: 'loop-cancel',
  iteration,
})

console.log(`Cancelled Clone Loop (was at iteration ${iteration}).`)
