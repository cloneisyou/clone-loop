#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
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
const positionalArgs = args.filter((arg) => !['--connect', '--no-open'].includes(arg))
const connectAfterStore = args.includes('--connect')
const noOpen = args.includes('--no-open')
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
  /clone:api-key login
  /clone:api-key login --no-open
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

function dashboardBaseUrl() {
  return String(process.env.CLONE_DASHBOARD_URL || 'https://clone.is').replace(/\/+$/, '')
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

async function connectResolvedToDashboard(resolved) {
  if (resolved.isDemo) {
    fail('Private Clone API key is required. Run /clone:api-key login, or create a key in Clone Dashboard and run /clone:api-key import-env --connect or /clone:api-key set <key> --connect.')
  }

  console.log('Connecting Clone Loop to Clone Dashboard via MCP...')
  console.log(`Source: ${resolved.source}`)
  console.log(`Token: ${resolved.masked}`)
  const sessionId = await startDashboardSession(resolved.token)
  console.log('Connected Clone Loop to Clone Dashboard.')
  console.log(`Clone session: ${sessionId}`)
  console.log(`Dashboard: ${dashboardSessionUrl(sessionId)}`)
}

async function connectToDashboard() {
  await connectResolvedToDashboard(resolveCloneToken())
}

function randomState() {
  return randomBytes(24).toString('base64url')
}

function openBrowser(url) {
  const platform = process.platform
  const command =
    platform === 'win32'
      ? { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
      : platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] }
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

async function startCallbackServer(expectedState) {
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let resolveCode
  let rejectCode
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
    if (requestUrl.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }

    const code = requestUrl.searchParams.get('code') || ''
    const state = requestUrl.searchParams.get('state') || ''
    if (!code || state !== expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Clone Loop login failed. You can close this tab and retry.')
      rejectCode(new Error('Clone Loop login callback state mismatch.'))
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Clone Loop connected</title><p>Clone Loop connected. You can close this tab.</p>')
    resolveCode(code)
  })
  server.once('error', (err) => {
    rejectReady(err)
    rejectCode(err)
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      rejectCode(new Error('Could not start Clone Loop login callback server.'))
      server.close()
      return
    }
    resolveReady({
      redirectUri: `http://127.0.0.1:${address.port}/callback`,
      codePromise,
      close: () => new Promise((resolveClose) => server.close(resolveClose)),
    })
  })
  return ready
}

async function exchangeCloneLoopCode({ code, state }) {
  const res = await fetch(`${dashboardBaseUrl()}/api/auth/clone-loop/connect/exchange/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, state }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body?.error || `Clone Loop login exchange failed with HTTP ${res.status}`)
  }
  const token = String(body?.key || '').trim()
  if (!token) throw new Error('Clone Loop login exchange did not return an API key.')
  return token
}

async function loginWithClone() {
  if (connectAfterStore) fail('Usage: /clone:api-key login [--no-open]')
  if (positionalArgs.length !== 1) fail('Usage: /clone:api-key login [--no-open]')

  const state = randomState()
  const callback = await startCallbackServer(state)
  const authorizeUrl = new URL('/clone-loop/connect', dashboardBaseUrl())
  authorizeUrl.searchParams.set('redirect_uri', callback.redirectUri)
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('agent_id', cloneLoopAgentId())

  console.log(`Authorize: ${authorizeUrl.toString()}`)
  if (!noOpen) {
    try {
      await openBrowser(authorizeUrl.toString())
    } catch (err) {
      console.log(`Open this URL in your browser: ${authorizeUrl.toString()}`)
      console.log(`Browser launch failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log('Waiting for Clone browser authorization...')

  try {
    const code = await callback.codePromise
    await callback.close()
    const token = await exchangeCloneLoopCode({ code, state })
    writePluginConfigToken(token)
    console.log('Stored Clone API key from Clone OAuth login.')
    console.log(`Token: ${maskToken(token)}`)
    console.log(`Plugin config: ${authFilePath()}`)
    await connectResolvedToDashboard({
      token,
      source: 'plugin config',
      masked: maskToken(token),
      isDemo: false,
    })
  } catch (err) {
    try {
      await callback.close()
    } catch {}
    fail(err instanceof Error ? err.message : String(err))
  }
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

if (command === 'login') {
  handled = true
  await loginWithClone()
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
