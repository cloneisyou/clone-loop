#!/usr/bin/env node

import { appendLoopHistory, validateActiveLoopState } from './loop-state-guard.mjs'
import { resolve } from 'node:path'

let LOOP_STATE_FILE = resolve(process.cwd(), '.claude', 'clone-loop.local.md')
let LOOP_HISTORY_FILE = resolve(process.cwd(), '.claude', 'clone-loop.history.local.jsonl')
const CAP = 240

function readStdin() {
  return new Promise((resolveRead) => {
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      input += chunk
    })
    process.stdin.on('end', () => resolveRead(input))
  })
}

function parseJson(input) {
  const normalized = input.replace(/^\uFEFF/, '').trim()
  return normalized ? JSON.parse(normalized) : {}
}

function stringValue(value) {
  return String(value || '').trim()
}

function truncate(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= CAP) return text
  return `${text.slice(0, CAP - 3)}...`
}

function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return ''
  if (toolInput.file_path) return stringValue(toolInput.file_path)
  if (toolInput.path) return stringValue(toolInput.path)
  if (toolInput.patch) return extractApplyPatchPaths(toolInput.patch).join(', ')
  if (Array.isArray(toolInput.edits)) {
    const paths = toolInput.edits
      .map((edit) => stringValue(edit?.file_path || edit?.path))
      .filter(Boolean)
    return [...new Set(paths)].join(', ')
  }
  return ''
}

function extractApplyPatchPaths(patch) {
  const paths = []
  for (const line of String(patch || '').split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/)
    if (match) paths.push(match[1].trim())
  }
  return [...new Set(paths.filter(Boolean))]
}

function extractSuccess(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object') return null
  if (typeof toolResponse.success === 'boolean') return toolResponse.success
  if (typeof toolResponse.is_error === 'boolean') return !toolResponse.is_error
  if (typeof toolResponse.error === 'string' && toolResponse.error) return false
  return null
}

function summarize({ toolName, filePath, toolInput, toolResponse }) {
  const action = filePath ? `${toolName} ${filePath}` : toolName
  const responseText = toolResponse && typeof toolResponse === 'object'
    ? truncate(toolResponse.message || toolResponse.error || toolResponse.output || '')
    : ''
  const editCount = Array.isArray(toolInput?.edits) ? ` (${toolInput.edits.length} edits)` : ''
  return responseText ? `${action}${editCount}: ${responseText}` : `${action}${editCount}`
}

function appendHistory(record) {
  appendLoopHistory(LOOP_HISTORY_FILE, record)
}

async function main() {
  const hookInput = parseJson(await readStdin())
  const root = hookInput.cwd ? resolve(String(hookInput.cwd)) : process.cwd()
  LOOP_STATE_FILE = resolve(root, '.claude', 'clone-loop.local.md')
  LOOP_HISTORY_FILE = resolve(root, '.claude', 'clone-loop.history.local.jsonl')
  const hookSession = hookInput.session_id ? stringValue(hookInput.session_id) : ''
  const validation = validateActiveLoopState({
    statePath: LOOP_STATE_FILE,
    historyPath: LOOP_HISTORY_FILE,
    hookSession,
    source: 'post-tool-use',
  })
  if (!validation.ok) return
  const { state } = validation

  const toolName = stringValue(hookInput.tool_name || hookInput.toolName)
  if (!/^(Write|Edit|MultiEdit|apply_patch)$/.test(toolName)) return

  const toolInput = hookInput.tool_input && typeof hookInput.tool_input === 'object'
    ? hookInput.tool_input
    : {}
  const toolResponse = hookInput.tool_response && typeof hookInput.tool_response === 'object'
    ? hookInput.tool_response
    : {}
  const filePath = extractFilePath(toolInput)
  const success = extractSuccess(toolResponse)

  appendHistory({
    event: 'post-tool-use',
    iteration: Number(state.frontmatter.iteration || 0),
    tool_name: toolName,
    file_path: filePath || null,
    success,
    summary: summarize({ toolName, filePath, toolInput, toolResponse }),
  })
}

main().catch((error) => {
  console.error(`Clone PostToolUse capture failed: ${error?.message || String(error)}`)
  process.exitCode = 1
})
