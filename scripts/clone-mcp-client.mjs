import { PLUGIN_VERSION } from './plugin-version.mjs'

export const DEFAULT_CLONE_MCP_URL = 'https://api.clone.is/mcp'
export const CLONE_MCP_CLIENT_NAME = 'clone-loop'

export function cloneMcpEndpoint() {
  return process.env.CLONE_MCP_URL || DEFAULT_CLONE_MCP_URL
}

export function cloneMcpClientInfo() {
  return {
    name: CLONE_MCP_CLIENT_NAME,
    version: PLUGIN_VERSION,
  }
}

export function parseMcpPayload(text) {
  const dataFrames = String(text || '')
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n')
        .trim(),
    )
    .filter(Boolean)

  for (const data of dataFrames) {
    try {
      return JSON.parse(data)
    } catch {}
  }

  return text ? JSON.parse(text) : null
}

export async function cloneMcpRpc(endpoint, token, method, params = {}, sessionId = '') {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-Clone-API-Key': token,
  }
  if (sessionId) headers['mcp-session-id'] = sessionId

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Clone MCP ${method} failed with HTTP ${res.status}${text ? `: ${text.slice(0, 500)}` : ''}`)
  }
  const payload = text ? parseMcpPayload(text) : null
  if (payload?.error) {
    throw new Error(`Clone MCP ${method} failed: ${payload.error.message || JSON.stringify(payload.error)}`)
  }

  return {
    sessionId: res.headers.get('mcp-session-id') || sessionId,
    payload,
  }
}
