// Helpers for assembling multi-turn conversation context that the Clone Loop
// hooks send to Clone MCP `predict_next_prompt`.
//
// The Stop hook and the AskUserQuestion hook both need the same shape:
//   - the original 1-turn user prompt (always preserved)
//   - all Clone-injected user turns reconstructed from the loop history JSONL
//   - the assistant text emitted during the current iteration
//
// This module is intentionally side-effect free so it can be imported from
// hooks and unit-tested without spinning up a fake MCP server.

import { existsSync, readFileSync } from 'node:fs'

export const HISTORY_WINDOW_TURNS = 20

// tool_result blocks can be very large (full file contents, build logs).
// Keep the first N + last M lines so the predictor sees what the tool did
// and what its outcome was without paying for every middle line.
export const TOOL_RESULT_HEAD_LINES = 4
export const TOOL_RESULT_TAIL_LINES = 2

// Hard cap per individual block so a runaway tool_use input or text block
// cannot blow up the payload.
export const ITERATION_BLOCK_CHAR_CAP = 1200

// Wider summary window for prior-iteration timelines: a couple of extra
// head/tail lines per tool_result helps the predictor see the rationale
// behind earlier decisions without paying for the middle.
export const PRIOR_ITER_TOOL_RESULT_HEAD_LINES = 8
export const PRIOR_ITER_TOOL_RESULT_TAIL_LINES = 4

// Total payload budget for the *combined* prior-iteration timelines. When
// exceeded, drop oldest iterations whole until the rest fit. The current
// iteration timeline and the original prompt are never counted against this
// cap — they are too important to drop.
export const PRIOR_ITER_TOTAL_CHAR_CAP = 12000

function safeJsonParse(line) {
  try {
    return JSON.parse(line.replace(/^﻿/, ''))
  } catch {
    return null
  }
}

/**
 * Reads `.claude/clone-loop.history.local.jsonl` and reconstructs the
 * chronological sequence of user turns that Clone has injected during the
 * active loop.
 *
 * Returns an array of `{ts, source, text, iteration?}` sorted by `ts`.
 * Silent on a missing file or unparseable lines.
 */
export function loadInjectedUserTurns(historyPath) {
  if (!historyPath || !existsSync(historyPath)) return []

  let raw
  try {
    raw = readFileSync(historyPath, 'utf8')
  } catch {
    return []
  }

  const turns = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    const record = safeJsonParse(line)
    if (!record || typeof record !== 'object') continue
    const ts = typeof record.ts === 'string' ? record.ts : ''

    if (record.event === 'stop' && record.decision === 'continue') {
      const text = typeof record.predicted_response === 'string' ? record.predicted_response : ''
      if (!text) continue
      turns.push({
        ts,
        source: 'clone-prediction',
        text,
        iteration: record.iteration,
      })
      continue
    }

    if (record.event === 'ask-user-question' && record.decision === 'auto-answer-freeform') {
      const answers = record.answers && typeof record.answers === 'object' ? record.answers : null
      if (!answers) continue
      for (const [question, answer] of Object.entries(answers)) {
        const q = String(question || '').trim()
        const a = String(answer ?? '').trim()
        if (!q && !a) continue
        turns.push({
          ts,
          source: 'auto-answer',
          text: `Q: ${q}\nA: ${a}`,
        })
      }
      continue
    }

    if (record.event === 'ask-user-question' && record.decision === 'auto-answer-fallback-mcp-error') {
      const q = String(record.question || '').trim()
      const a = String(record.answer || '').trim()
      if (!q && !a) continue
      turns.push({
        ts,
        source: 'auto-answer-fallback',
        text: `Q: ${q}\nA: ${a}`,
      })
      continue
    }
  }

  return turns.sort((left, right) => {
    if (left.ts < right.ts) return -1
    if (left.ts > right.ts) return 1
    return 0
  })
}

function detectTimestampField(records) {
  for (const record of records) {
    if (typeof record?.timestamp === 'string') return 'timestamp'
    if (typeof record?.ts === 'string') return 'ts'
  }
  return null
}

function compareTimestamp(left, right) {
  const leftMs = Date.parse(String(left || ''))
  const rightMs = Date.parse(String(right || ''))
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return leftMs - rightMs
  }
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function extractAssistantTexts(record) {
  if (record?.type === 'event_msg' && record?.payload?.type === 'agent_message') {
    const message = String(record.payload.message || '').trim()
    return message ? [message] : []
  }

  const message = record?.message || (
    record?.type === 'response_item' && record?.payload?.type === 'message'
      ? record.payload
      : null
  )
  if (message?.role !== 'assistant') return []
  const content = message.content
  if (!Array.isArray(content)) return []
  const texts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
      texts.push(block.text)
    } else if (block?.type === 'output_text' && typeof block.text === 'string' && block.text) {
      texts.push(block.text)
    }
  }
  return texts
}

/**
 * Reads the Claude Code transcript JSONL and collects assistant text blocks
 * emitted during the current loop iteration. Throws on JSON parse error so
 * the caller can fall back gracefully.
 *
 * Filtering rules:
 *   - If the records have a recognizable timestamp field (`timestamp` or
 *     `ts`) and `sinceTs` is non-empty, only records with timestamp strictly
 *     greater than `sinceTs` are kept.
 *   - Otherwise (no usable timestamp field OR `sinceTs` empty) all assistant
 *     texts in the transcript are returned (graceful degradation).
 */
export function assistantTextsThisIteration(transcriptPath, sinceTs) {
  if (!transcriptPath) return []
  const raw = readFileSync(transcriptPath, 'utf8')
  const records = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    records.push(JSON.parse(line.replace(/^﻿/, '')))
  }

  const timestampField = detectTimestampField(records)
  const useFilter = Boolean(timestampField) && Boolean(sinceTs)

  const texts = []
  for (const record of records) {
    if (useFilter) {
      const recordTs = record?.[timestampField]
      if (typeof recordTs !== 'string' || compareTimestamp(recordTs, sinceTs) <= 0) continue
    }
    for (const text of extractAssistantTexts(record)) {
      texts.push(text)
    }
  }

  return texts
}

function toolResultBlockText(block) {
  const content = block?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part?.type === 'text' && typeof part.text === 'string') return part.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function extractIterationBlocks(record) {
  if (record?.type === 'response_item' && record?.payload?.type === 'function_call') {
    return [{
      kind: 'tool_use',
      id: String(record.payload.call_id || ''),
      name: String(record.payload.name || ''),
      input: safeJsonObject(record.payload.arguments),
    }]
  }
  if (record?.type === 'response_item' && record?.payload?.type === 'function_call_output') {
    return [{
      kind: 'tool_result',
      toolUseId: String(record.payload.call_id || ''),
      text: String(record.payload.output || ''),
    }]
  }
  if (record?.type === 'event_msg' && record?.payload?.type === 'agent_message') {
    const text = String(record.payload.message || '').trim()
    return text ? [{ kind: 'text', text }] : []
  }

  const message = record?.message || (
    record?.type === 'response_item' && record?.payload?.type === 'message'
      ? record.payload
      : null
  )
  const role = message?.role
  const content = message?.content
  if (!role || !Array.isArray(content)) return []
  const blocks = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (role === 'assistant' && block.type === 'text' && block.text) {
      blocks.push({ kind: 'text', text: String(block.text) })
    } else if (role === 'assistant' && block.type === 'output_text' && block.text) {
      blocks.push({ kind: 'text', text: String(block.text) })
    } else if (role === 'assistant' && block.type === 'tool_use') {
      blocks.push({ kind: 'tool_use', name: String(block.name || ''), input: block.input ?? {} })
    } else if (role === 'user' && block.type === 'tool_result') {
      blocks.push({
        kind: 'tool_result',
        toolUseId: String(block.tool_use_id || ''),
        text: toolResultBlockText(block),
      })
    }
  }
  return blocks
}

function safeJsonObject(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return { arguments: String(value) }
  }
}

/**
 * Reads the Claude Code transcript JSONL and collects every chronologically-
 * ordered block from the current iteration: assistant text, assistant
 * tool_use calls, and the matching user tool_result outputs. Used to build
 * a rich `agent_input` so Clone sees what the agent actually did, not just
 * its narrating prose.
 *
 * Same timestamp-filter semantics as `assistantTextsThisIteration`: records
 * with timestamp <= sinceTs are dropped when a usable field exists, else
 * everything is returned.
 *
 * Throws on JSON parse error so callers can fall back.
 */
function readTranscriptRecords(transcriptPath) {
  const raw = readFileSync(transcriptPath, 'utf8')
  const records = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    records.push(JSON.parse(line.replace(/^﻿/, '')))
  }
  return records
}

function buildToolNameMap(records) {
  const toolNameById = new Map()
  for (const record of records) {
    if (record?.type === 'response_item' && record?.payload?.type === 'function_call') {
      const id = record.payload.call_id || record.payload.id
      if (id) toolNameById.set(String(id), String(record.payload.name || ''))
      continue
    }
    const content = record?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'tool_use' && block.id) {
        toolNameById.set(String(block.id), String(block.name || ''))
      }
    }
  }
  return toolNameById
}

function collectBlocksInRange({ records, timestampField, startExclusive, endInclusive, toolNameById }) {
  const blocks = []
  for (const record of records) {
    if (timestampField) {
      const ts = record?.[timestampField]
      if (typeof ts !== 'string') continue
      if (startExclusive && compareTimestamp(ts, startExclusive) <= 0) continue
      if (endInclusive && compareTimestamp(ts, endInclusive) > 0) continue
    }
    for (const block of extractIterationBlocks(record)) {
      if (block.kind === 'tool_result') {
        block.name = toolNameById.get(block.toolUseId) || ''
      }
      blocks.push(block)
    }
  }
  return blocks
}

export function iterationBlocksThisIteration(transcriptPath, sinceTs) {
  if (!transcriptPath) return []
  const records = readTranscriptRecords(transcriptPath)
  const timestampField = detectTimestampField(records)
  const useFilter = Boolean(timestampField) && Boolean(sinceTs)
  const toolNameById = buildToolNameMap(records)
  return collectBlocksInRange({
    records,
    timestampField: useFilter ? timestampField : null,
    startExclusive: sinceTs || '',
    endInclusive: '',
    toolNameById,
  })
}

/**
 * Reads the loop-history JSONL and returns iteration boundaries as an array
 * of `{iteration, startExclusive, endInclusive}`. Boundaries are derived
 * from the `loop-start` ts (start of iter 1) and from each
 * `decision: "continue"` ts (which simultaneously ends iter N and starts
 * iter N+1, where N+1 is taken from the record's `iteration` field).
 *
 * The last entry in the array represents the *current* iteration: its
 * `endInclusive` is empty so callers can keep up-to-now content for the
 * footer.
 *
 * Returns an empty array if the history file is missing or has no usable
 * records.
 */
export function loadIterationBoundaries(historyPath) {
  if (!historyPath || !existsSync(historyPath)) return []
  let raw
  try {
    raw = readFileSync(historyPath, 'utf8')
  } catch {
    return []
  }
  let loopStartTs = ''
  const continues = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    const record = safeJsonParse(line)
    if (!record || typeof record !== 'object') continue
    const ts = typeof record.ts === 'string' ? record.ts : ''
    if (!ts) continue
    if (record.event === 'loop-start' && !loopStartTs) {
      loopStartTs = ts
    } else if (record.event === 'stop' && record.decision === 'continue') {
      const iter = Number(record.iteration)
      if (Number.isFinite(iter)) {
        continues.push({ ts, iteration: iter })
      }
    }
  }
  continues.sort((left, right) => (left.ts < right.ts ? -1 : left.ts > right.ts ? 1 : 0))

  const boundaries = []
  let prevTs = loopStartTs
  let prevIter = 1
  for (const entry of continues) {
    boundaries.push({ iteration: prevIter, startExclusive: prevTs, endInclusive: entry.ts })
    prevTs = entry.ts
    prevIter = entry.iteration
  }
  // Tail boundary = current iteration, no end ts.
  boundaries.push({ iteration: prevIter, startExclusive: prevTs, endInclusive: '' })
  return boundaries
}

/**
 * Splits the transcript into per-iteration timelines using the boundaries
 * from `loadIterationBoundaries`. Returns an array of
 * `{iteration, startExclusive, endInclusive, blocks}`. Iterations whose
 * window contains no usable blocks are still returned with an empty
 * `blocks` array so callers can choose what to render.
 *
 * Throws on transcript JSON parse error so callers can fall back.
 */
export function iterationTimelinesByBoundary(transcriptPath, boundaries) {
  if (!transcriptPath) return []
  const safeBoundaries = Array.isArray(boundaries) ? boundaries : []
  if (!safeBoundaries.length) return []
  const records = readTranscriptRecords(transcriptPath)
  const timestampField = detectTimestampField(records)
  const toolNameById = buildToolNameMap(records)
  return safeBoundaries.map((boundary) => ({
    iteration: boundary.iteration,
    startExclusive: boundary.startExclusive,
    endInclusive: boundary.endInclusive,
    blocks: collectBlocksInRange({
      records,
      timestampField: timestampField || null,
      startExclusive: boundary.startExclusive || '',
      endInclusive: boundary.endInclusive || '',
      toolNameById,
    }),
  }))
}

function summarizeMultiline(text, head, tail, label) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length <= head + tail + 1) {
    return normalized.trim() || `(empty ${label})`
  }
  const headPart = lines.slice(0, head).join('\n')
  const tailPart = lines.slice(-tail).join('\n')
  return `${headPart}\n... [${lines.length - head - tail} more ${label} lines] ...\n${tailPart}`
}

function truncateString(value, cap) {
  const s = String(value ?? '')
  if (s.length <= cap) return s
  return `${s.slice(0, cap - 3)}...`
}

function formatToolUseInput(input) {
  if (!input || typeof input !== 'object') return ''
  const parts = []
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue
    let rendered
    if (typeof value === 'string') {
      rendered = JSON.stringify(truncateString(value, 120))
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      rendered = String(value)
    } else {
      rendered = truncateString(JSON.stringify(value), 120)
    }
    parts.push(`${key}=${rendered}`)
  }
  return parts.join(' ')
}

function formatIterationBlock(block, options) {
  const head = options.toolResultHead ?? TOOL_RESULT_HEAD_LINES
  const tail = options.toolResultTail ?? TOOL_RESULT_TAIL_LINES
  const cap = options.blockCharCap ?? ITERATION_BLOCK_CHAR_CAP

  if (block.kind === 'text') {
    return truncateString(block.text, cap)
  }
  if (block.kind === 'tool_use') {
    const args = formatToolUseInput(block.input)
    return truncateString(`[tool_use] ${block.name}: ${args}`.trim(), cap)
  }
  if (block.kind === 'tool_result') {
    const label = block.name ? `[tool_result ${block.name}]:` : '[tool_result]:'
    const body = summarizeMultiline(block.text, head, tail, block.name || 'output')
    return truncateString(`${label}\n${body}`, cap)
  }
  return ''
}

/**
 * Serializes the current iteration's blocks (text + tool_use + tool_result)
 * into a single string for the assistant footer. Each block is separated by
 * a blank line so the predictor can see the flow of actions.
 */
export function formatIterationBlocks(blocks, options = {}) {
  if (!Array.isArray(blocks) || !blocks.length) return ''
  return blocks
    .map((block) => formatIterationBlock(block, options))
    .filter(Boolean)
    .join('\n\n')
}

function formatTurn(turn) {
  return `### user (${turn.source}):\n${turn.text}`
}

/**
 * Renders prior-iteration timelines into a Map<iteration, formattedString>.
 * Iterations whose total formatted size would push the running total above
 * `totalCharCap` are dropped *whole*, oldest first, until the rest fit.
 * Returns a plain object: { kept: Map, droppedIterations: number[] }.
 */
function renderPriorIterTimelines(priorIterTimelines, options = {}) {
  const cap = Number.isFinite(Number(options.totalCharCap)) && Number(options.totalCharCap) > 0
    ? Number(options.totalCharCap)
    : PRIOR_ITER_TOTAL_CHAR_CAP
  const formatOptions = {
    toolResultHead: options.toolResultHead ?? PRIOR_ITER_TOOL_RESULT_HEAD_LINES,
    toolResultTail: options.toolResultTail ?? PRIOR_ITER_TOOL_RESULT_TAIL_LINES,
  }
  const safe = Array.isArray(priorIterTimelines) ? priorIterTimelines : []
  // Render newest first so we can keep the most recent iters when capping.
  const rendered = []
  for (const entry of safe) {
    if (!entry || !Array.isArray(entry.blocks) || !entry.blocks.length) continue
    const body = formatIterationBlocks(entry.blocks, formatOptions)
    if (!body) continue
    rendered.push({ iteration: entry.iteration, body })
  }
  // Walk from newest to oldest, accumulating size; stop adding once cap blown.
  rendered.sort((left, right) => Number(right.iteration) - Number(left.iteration))
  let used = 0
  const kept = new Map()
  const droppedIterations = []
  for (const entry of rendered) {
    const cost = entry.body.length
    if (used + cost > cap) {
      droppedIterations.push(entry.iteration)
      continue
    }
    kept.set(entry.iteration, entry.body)
    used += cost
  }
  droppedIterations.sort((left, right) => Number(left) - Number(right))
  return { kept, droppedIterations }
}

/**
 * Builds the single-string `agent_input` sent to Clone MCP.
 *
 * Layout:
 *   1. "Original Clone Loop prompt" — the 1-turn user prompt, always preserved.
 *   2. "Conversation history" — the most recent `windowTurns` Clone-injected
 *      user turns (predictions + auto-answers) in chronological order. Drops
 *      oldest first if over the cap. Each `clone-prediction` turn is
 *      followed by a "### assistant (prior iter N timeline):" block when a
 *      matching entry is found in `priorIterTimelines`.
 *   3. "assistant (current iter N)" — what Claude did this iteration.
 *      Preferred input: `iterationBlocks` (text + tool_use + tool_result
 *      timeline). Fallback: `assistantTexts` (text only). Never windowed so
 *      the freshest output cannot be lost.
 *
 * The combined prior-iter timelines are capped at `PRIOR_ITER_TOTAL_CHAR_CAP`
 * chars; oldest iters drop first when over budget.
 */
export function formatConversationHistory({
  promptText,
  iteration,
  threshold,
  injectedUserTurns,
  assistantTexts,
  iterationBlocks,
  priorIterTimelines,
  priorIterOptions,
  windowTurns,
}) {
  const safePrompt = String(promptText || '').trim()
  const safeIteration = iteration == null ? '' : String(iteration)
  const safeThreshold = threshold == null ? '' : String(threshold)
  const safeAssistantTexts = Array.isArray(assistantTexts) ? assistantTexts.filter(Boolean) : []
  const safeIterationBlocks = Array.isArray(iterationBlocks) ? iterationBlocks : []
  const safeUserTurns = Array.isArray(injectedUserTurns) ? injectedUserTurns : []
  const cap = Number.isFinite(Number(windowTurns)) && Number(windowTurns) > 0
    ? Number(windowTurns)
    : HISTORY_WINDOW_TURNS

  const trimmedUserTurns = safeUserTurns.length > cap
    ? safeUserTurns.slice(safeUserTurns.length - cap)
    : safeUserTurns

  const { kept: priorByIter, droppedIterations } = renderPriorIterTimelines(
    priorIterTimelines,
    priorIterOptions || {},
  )

  const historyParts = []
  if (trimmedUserTurns.length) {
    for (const turn of trimmedUserTurns) {
      historyParts.push(formatTurn(turn))
      if (turn.source === 'clone-prediction') {
        const iterNum = Number(turn.iteration)
        if (Number.isFinite(iterNum) && priorByIter.has(iterNum)) {
          historyParts.push(`### assistant (prior iter ${iterNum} timeline):\n${priorByIter.get(iterNum)}`)
        }
      }
    }
  }
  if (droppedIterations.length) {
    historyParts.push(
      `(prior-iter timelines dropped due to char cap: ${droppedIterations.join(', ')})`,
    )
  }

  const historyBlock = historyParts.length ? historyParts.join('\n\n') : '(no prior user turns)'

  let currentAssistantBlock
  if (safeIterationBlocks.length) {
    currentAssistantBlock = formatIterationBlocks(safeIterationBlocks)
  } else if (safeAssistantTexts.length) {
    currentAssistantBlock = safeAssistantTexts.join('\n\n')
  } else {
    currentAssistantBlock = '(no assistant text yet)'
  }

  return `Original Clone Loop prompt:
${safePrompt}

Clone Loop iteration: ${safeIteration}
Clone threshold: ${safeThreshold}

=== Conversation history (most recent ${cap} user turns) ===

${historyBlock}

### assistant (current iter ${safeIteration}):
${currentAssistantBlock}

---
Given the conversation and the assistant's work above, predict the most
likely next prompt the user would send to continue this task.

Rules:
- Write as if you are the user typing their next message.
- Be specific: reference concrete artifacts, file names, test results, or
  next steps that follow naturally from what the assistant just did.
- Minimum 1 full sentence. No single words, no "ok", no "looks good",
  no bare affirmations.
- If the current work is complete, the prompt should ask for the next
  logical feature, verification step, or follow-up action.`
}
