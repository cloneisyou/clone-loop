#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { loopHistoryPath, loopStatePath } from './clone-paths.mjs'
import { appendLoopHistory, parseState, removeLoopState } from './loop-state-guard.mjs'

const root = process.cwd()
const statePath = loopStatePath(root)
const historyPath = loopHistoryPath(root)

if (!existsSync(statePath)) {
  console.log('No active Clone Loop found.')
  process.exit(0)
}

let iteration = 'unknown'
try {
  const state = parseState(readFileSync(statePath, 'utf8'))
  iteration = state?.frontmatter?.iteration || iteration
} catch {}

removeLoopState(statePath)
appendLoopHistory(historyPath, {
  event: 'loop-cancel',
  iteration,
})

console.log(`Cancelled Clone Loop (was at iteration ${iteration}).`)
