import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { nowIso } from './clone-utils.mjs'

const DEFAULT_TTL_HOURS = 24

export function parseYamlScalar(value) {
  const raw = value.trim()
  if (raw === 'null') return null
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return raw
}

export function parseState(content) {
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

  return {
    frontmatter,
    prompt: match[2].replace(/^\r?\n/, ''),
    content,
  }
}

export function appendLoopHistory(historyPath, record) {
  try {
    appendFileSync(historyPath, `${JSON.stringify({ ts: nowIso(), ...record })}\n`)
  } catch {}
}

export function removeLoopState(statePath) {
  rmSync(statePath, { force: true })
}

function stringValue(value) {
  return String(value || '').trim()
}

function readHistoryRecords(historyPath) {
  if (!existsSync(historyPath)) return []
  return readFileSync(historyPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const record = JSON.parse(line.replace(/^\uFEFF/, ''))
        return record && typeof record === 'object' ? [record] : []
      } catch {
        return []
      }
    })
}

function recordsForSession(historyPath, sessionId) {
  return readHistoryRecords(historyPath).filter((record) => {
    const recordSession = stringValue(record.session_id)
    return !recordSession || recordSession === sessionId
  })
}

function hasLoopStartForSession(records, sessionId) {
  return records.some((record) =>
    record.event === 'loop-start' && stringValue(record.session_id) === sessionId
  )
}

function lastActivityMs(records) {
  let latest = 0
  for (const record of records) {
    const ts = Date.parse(String(record.ts || ''))
    if (Number.isFinite(ts) && ts > latest) latest = ts
  }
  return latest
}

function isExpired(records, ttlHours, nowMs) {
  const activityMs = lastActivityMs(records)
  if (!activityMs) return true
  const ttlMs = Number(ttlHours) * 60 * 60 * 1000
  return nowMs - activityMs > ttlMs
}

export function validateActiveLoopState({
  statePath,
  historyPath,
  hookSession,
  source,
  ttlHours = DEFAULT_TTL_HOURS,
  removeStale = true,
  now = new Date(),
} = {}) {
  if (!existsSync(statePath)) return { ok: false, reason: 'inactive' }

  const state = parseState(readFileSync(statePath, 'utf8'))
  if (!state) {
    appendLoopHistory(historyPath, {
      event: source,
      decision: 'stale-corrupt-state',
    })
    if (removeStale) removeLoopState(statePath)
    return { ok: false, reason: 'stale-corrupt-state' }
  }

  const stateSession = stringValue(state.frontmatter.session_id)
  const currentSession = stringValue(hookSession)
  const staleBase = {
    event: source,
    state_session_id: stateSession || null,
    hook_session_id: currentSession || null,
  }

  if (!stateSession || !currentSession) {
    appendLoopHistory(historyPath, {
      ...staleBase,
      decision: 'stale-missing-session-id',
    })
    if (removeStale) removeLoopState(statePath)
    return { ok: false, reason: 'stale-missing-session-id', state }
  }

  if (stateSession !== currentSession) {
    appendLoopHistory(historyPath, {
      ...staleBase,
      decision: 'stale-session-state',
    })
    if (removeStale) removeLoopState(statePath)
    return { ok: false, reason: 'stale-session-state', state }
  }

  const sessionRecords = recordsForSession(historyPath, currentSession)

  if (!hasLoopStartForSession(sessionRecords, currentSession)) {
    appendLoopHistory(historyPath, {
      ...staleBase,
      decision: 'stale-missing-loop-start',
    })
    if (removeStale) removeLoopState(statePath)
    return { ok: false, reason: 'stale-missing-loop-start', state }
  }

  if (isExpired(sessionRecords, ttlHours, now.getTime())) {
    appendLoopHistory(historyPath, {
      ...staleBase,
      decision: 'stale-expired-state',
      started_at: state.frontmatter.started_at || null,
      last_activity_at: sessionRecords
        .map((record) => String(record.ts || ''))
        .filter(Boolean)
        .sort()
        .at(-1) || null,
      ttl_hours: Number(ttlHours),
    })
    if (removeStale) removeLoopState(statePath)
    return { ok: false, reason: 'stale-expired-state', state }
  }

  return { ok: true, state }
}
