#!/usr/bin/env node

import {
  authFilePath,
  clearPluginConfigToken,
  isPluginDataDirInjected,
  maskToken,
  pluginDataDir,
  resolveCloneToken,
  writePluginConfigToken,
} from './clone-auth.mjs'
import { cloneMcpClientInfo, cloneMcpEndpoint, cloneMcpRpc } from './clone-mcp-client.mjs'

const args = process.argv.slice(2)
const positionalArgs = args.filter((arg) => arg !== '--connect')
const connectAfterStore = args.includes('--connect')
const command = positionalArgs[0] || 'status'
let handled = false

function cloneLoopAgentId() {
  const explicit = String(process.env.CLONE_LOOP_AGENT_ID || '').trim()
  if (explicit) return explicit

  if (process.env.CLAUDE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_ROOT) {
    return 'claude-code'
  }

  const hasCodexPluginData = Boolean(process.env.PLUGIN_DATA) && !process.env.CLAUDE_PLUGIN_DATA
  const hasCodexPluginRoot = Boolean(process.env.PLUGIN_ROOT) && !process.env.CLAUDE_PLUGIN_ROOT
  const hasCodexRuntime =
    Boolean(process.env.CODEX_HOME) ||
    Boolean(process.env.CODEX_SESSION_ID) ||
    Boolean(process.env.CODEX_THREAD_ID)

  return hasCodexPluginData || hasCodexPluginRoot || hasCodexRuntime ? 'codex' : 'claude-code'
}

function cloneLoopSourceDetail() {
  return `clone-loop:${cloneLoopAgentId()}`
}

function usage() {
  console.log(`Clone API key manager

USAGE:
  /clone:api-key status
  /clone:api-key import-env
  /clone:api-key import-env --connect
  /clone:api-key set <key>
  /clone:api-key set <key> --connect
  /clone:api-key connect
  /clone:api-key clear

TOKEN PRIORITY:
  1. CLONE_API_TOKEN environment variable
  2. Plugin config in PLUGIN_DATA/auth.local.json or CLAUDE_PLUGIN_DATA/auth.local.json
  3. Public demo fallback token`)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseToolBody(payload, toolName) {
  const content = payload?.result?.content?.[0]
  if (payload?.result?.isError) {
    throw new Error(`${toolName} returned an error: ${content?.text || 'unknown MCP tool error'}`)
  }
  if (content?.type !== 'text' || !content.text) {
    throw new Error(`${toolName} returned an empty response`)
  }

  try {
    return JSON.parse(content.text)
  } catch {
    throw new Error(`${toolName} returned non-JSON response: ${content.text}`)
  }
}

function dashboardSessionUrl(sessionId) {
  const base = String(process.env.CLONE_DASHBOARD_URL || 'https://clone.is').replace(/\/+$/, '')
  return `${base}/console?session=${encodeURIComponent(sessionId)}#sources`
}

async function startDashboardSession(token) {
  const endpoint = cloneMcpEndpoint()
  const init = await cloneMcpRpc(endpoint, token, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: cloneMcpClientInfo(),
  })
  if (!init.sessionId) throw new Error('MCP initialize did not return an mcp-session-id header.')

  const started = await cloneMcpRpc(
    endpoint,
    token,
    'tools/call',
    {
      name: 'start_session',
      arguments: {
        source: 'agent',
        source_detail: cloneLoopSourceDetail(),
      },
    },
    init.sessionId,
  )
  const body = parseToolBody(started.payload, 'start_session')
  const cloneSessionId = body.session_id || body.sessionId
  if (!cloneSessionId) throw new Error('start_session did not return a Clone session id.')
  return cloneSessionId
}

async function connectToDashboard() {
  const resolved = resolveCloneToken()
  if (resolved.isDemo) {
    fail('Private Clone API key is required. Create a key in Clone Dashboard, then run /clone:api-key import-env --connect or /clone:api-key set <key> --connect.')
  }

  console.log('Connecting Clone Loop to Clone Dashboard via MCP...')
  console.log(`Source: ${resolved.source}`)
  console.log(`Token: ${resolved.masked}`)
  const sessionId = await startDashboardSession(resolved.token)
  console.log('Connected Clone Loop to Clone Dashboard.')
  console.log(`Clone session: ${sessionId}`)
  console.log(`Dashboard: ${dashboardSessionUrl(sessionId)}`)
}

function printResolvedToken(prefix = '') {
  const resolved = resolveCloneToken()
  if (prefix) console.log(prefix)
  console.log(`Source: ${resolved.source}`)
  console.log(`Token: ${resolved.masked}`)

  const injected = isPluginDataDirInjected()
  if (injected) {
    console.log(`Plugin config: ${authFilePath()}`)
  } else {
    console.log(`Plugin config: ${authFilePath()} (fallback path — PLUGIN_DATA/CLAUDE_PLUGIN_DATA not injected)`)
  }

  if (resolved.isDemo) {
    console.log('Using the shared public demo fallback. Configure your own key for private Clone memory.')
  }
}

if (command === '-h' || command === '--help' || command === 'help') {
  usage()
  process.exit(0)
}

if (command === 'status') {
  if (connectAfterStore) fail('Usage: /clone:api-key status')
  if (args.length !== 1 && args.length !== 0) fail('Usage: /clone:api-key status')
  printResolvedToken()
  process.exit(0)
}

if (command === 'import-env') {
  handled = true
  if (positionalArgs.length !== 1) fail('Usage: /clone:api-key import-env [--connect]')
  const token = String(process.env.CLONE_API_TOKEN || '').trim()
  if (!token) fail('CLONE_API_TOKEN is not set in this agent process.')

  writePluginConfigToken(token)
  console.log('Stored Clone API key from CLONE_API_TOKEN.')
  console.log(`Token: ${maskToken(token)}`)
  console.log(`Plugin config: ${authFilePath()}`)
  if (connectAfterStore) {
    try {
      await connectToDashboard()
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  } else {
    process.exit(0)
  }
}

if (command === 'set') {
  handled = true
  if (positionalArgs.length !== 2 || !String(positionalArgs[1] || '').trim()) {
    fail('Usage: /clone:api-key set <key> [--connect]')
  }

  const token = String(positionalArgs[1]).trim()
  writePluginConfigToken(token)
  console.log('Stored Clone API key in plugin config.')
  console.log(`Token: ${maskToken(token)}`)
  console.log(`Plugin config: ${authFilePath()}`)
  console.log('Prefer import-env when possible because direct slash-command arguments may remain in the transcript.')
  if (connectAfterStore) {
    try {
      await connectToDashboard()
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  } else {
    process.exit(0)
  }
}

if (command === 'connect') {
  handled = true
  if (positionalArgs.length !== 1) fail('Usage: /clone:api-key connect')
  try {
    await connectToDashboard()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}

if (command === 'clear') {
  if (args.length !== 1) fail('Usage: /clone:api-key clear')
  clearPluginConfigToken()
  console.log('Cleared plugin config API key.')
  printResolvedToken('Current effective token:')
  process.exit(0)
}

if (!handled) fail(`Unknown /clone:api-key command: ${command}`)
