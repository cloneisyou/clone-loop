#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const LOOP_STATE_FILE = resolve(process.cwd(), '.claude', 'clone-loop.local.md')
const LOOP_HISTORY_FILE = resolve(process.cwd(), '.claude', 'clone-loop.history.local.jsonl')
const CAP = 240

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

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

function parseYamlScalar(value) {
  const raw = value.trim()
  if (raw === 'null') return null
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return raw
}

function parseState(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const frontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1)
    frontmatter[key] = parseYamlScalar(value)
  }
  return { frontmatter }
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
  if (Array.isArray(toolInput.edits)) {
    const paths = toolInput.edits
      .map((edit) => stringValue(edit?.file_path || edit?.path))
      .filter(Boolean)
    return [...new Set(paths)].join(', ')
  }
  return ''
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
  appendFileSync(LOOP_HISTORY_FILE, `${JSON.stringify({ ts: nowIso(), ...record })}\n`)
}

async function main() {
  if (!existsSync(LOOP_STATE_FILE)) return

  const hookInput = parseJson(await readStdin())
  const state = parseState(readFileSync(LOOP_STATE_FILE, 'utf8'))
  if (!state) return

  const stateSession = stringValue(state.frontmatter.session_id)
  const hookSession = hookInput.session_id ? stringValue(hookInput.session_id) : ''
  if (stateSession && hookSession && stateSession !== hookSession) return

  const toolName = stringValue(hookInput.tool_name || hookInput.toolName)
  if (!/^(Write|Edit|MultiEdit)$/.test(toolName)) return

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
