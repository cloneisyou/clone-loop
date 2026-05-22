import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scriptPath = join(pluginRoot, 'scripts', 'manage-api-key.mjs')
const pluginVersion = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version

function runManager(args, options = {}) {
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: options.pluginDataDir,
    ...(options.env || {}),
  }
  delete env.CLONE_API_TOKEN
  if (options.env && Object.hasOwn(options.env, 'CLONE_API_TOKEN')) {
    env.CLONE_API_TOKEN = options.env.CLONE_API_TOKEN
  }

  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd || pluginRoot,
    env,
    encoding: 'utf8',
  })
}

function runManagerAsync(args, options = {}) {
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: options.pluginDataDir,
    ...(options.env || {}),
  }
  delete env.CLONE_API_TOKEN
  if (options.env && Object.hasOwn(options.env, 'CLONE_API_TOKEN')) {
    env.CLONE_API_TOKEN = options.env.CLONE_API_TOKEN
  }

  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: options.cwd || pluginRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (status) => {
      resolveRun({ status, stdout, stderr })
    })
  })
}

function withPluginData(callback) {
  const pluginDataDir = mkdtempSync(join(tmpdir(), 'clone-plugin-data-'))
  try {
    return callback(pluginDataDir)
  } finally {
    rmSync(pluginDataDir, { recursive: true, force: true })
  }
}

async function withPluginDataAsync(callback) {
  const pluginDataDir = mkdtempSync(join(tmpdir(), 'clone-plugin-data-'))
  try {
    return await callback(pluginDataDir)
  } finally {
    rmSync(pluginDataDir, { recursive: true, force: true })
  }
}

function readStoredToken(pluginDataDir) {
  const data = JSON.parse(readFileSync(join(pluginDataDir, 'auth.local.json'), 'utf8'))
  return data.clone_api_token
}

async function withMcpServer(callback) {
  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {}
      calls.push({
        method: payload.method,
        params: payload.params,
        apiKey: req.headers['x-clone-api-key'],
        mcpSessionId: req.headers['mcp-session-id'],
      })

      res.setHeader('Content-Type', 'application/json')
      if (payload.method === 'initialize') {
        res.setHeader('mcp-session-id', 'mcp-session-123')
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: { serverInfo: { name: 'clone' } },
        }))
        return
      }

      if (payload.method === 'tools/call' && payload.params?.name === 'start_session') {
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ session_id: 'clone-session-123' }),
              },
            ],
          },
        }))
        return
      }

      res.statusCode = 400
      res.end(JSON.stringify({ error: 'unexpected request' }))
    })
  })

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}/mcp`
  try {
    return await callback(url, calls)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

describe('Clone API key manager', () => {
  it('reports demo fallback status when no env token or plugin config exists', () => {
    withPluginData((pluginDataDir) => {
      const result = runManager(['status'], { pluginDataDir })

      assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
      assert.match(result.stdout, /Source: demo fallback/)
      assert.match(result.stdout, /Token: clone_yc.*\.\.\..*2026/)
      assert.doesNotMatch(result.stdout, /clone_yc-reviewer-public-demo-2026/)
    })
  })

  it('imports CLONE_API_TOKEN into plugin data without printing the full token', () => {
    withPluginData((pluginDataDir) => {
      const token = 'clone_import_env_token_1234567890'
      const result = runManager(['import-env'], {
        pluginDataDir,
        env: { CLONE_API_TOKEN: token },
      })

      assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
      assert.equal(readStoredToken(pluginDataDir), token)
      assert.match(result.stdout, /Stored Clone API key from CLONE_API_TOKEN/)
      assert.doesNotMatch(result.stdout, new RegExp(token))
    })
  })

  it('rejects connect when only the demo fallback token is available', () => {
    withPluginData((pluginDataDir) => {
      const result = runManager(['connect'], { pluginDataDir })

      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Private Clone API key is required/)
      assert.doesNotMatch(result.stdout, /Connected Clone Loop/)
    })
  })

  it('imports CLONE_API_TOKEN and pings MCP when --connect is set', async () => {
    await withMcpServer(async (mcpUrl, calls) => {
      await withPluginDataAsync(async (pluginDataDir) => {
        const token = 'clone_import_env_connect_token_1234567890'
        const result = await runManagerAsync(['import-env', '--connect'], {
          pluginDataDir,
          env: {
            CLONE_API_TOKEN: token,
            CLONE_MCP_URL: mcpUrl,
            CLONE_DASHBOARD_URL: 'https://dashboard.example',
          },
        })

        assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
        assert.equal(readStoredToken(pluginDataDir), token)
        assert.deepEqual(calls.map((call) => call.method), ['initialize', 'tools/call'])
        assert.deepEqual(calls[0].params.clientInfo, { name: 'clone-loop', version: pluginVersion })
        assert.equal(calls[0].apiKey, token)
        assert.equal(calls[1].apiKey, token)
        assert.equal(calls[1].mcpSessionId, 'mcp-session-123')
        assert.equal(calls[1].params.name, 'start_session')
        assert.deepEqual(calls[1].params.arguments, {
          source: 'agent',
          source_detail: 'clone-loop:claude-code',
        })
        assert.match(result.stdout, /Clone session: clone-session-123/)
        assert.match(result.stdout, /Dashboard: https:\/\/dashboard\.example\/console\?session=clone-session-123#sources/)
        assert.doesNotMatch(result.stdout, new RegExp(token))
      })
    })
  })

  it('sets a key and pings MCP when --connect is set', async () => {
    await withMcpServer(async (mcpUrl, calls) => {
      await withPluginDataAsync(async (pluginDataDir) => {
        const token = 'clone_set_connect_token_1234567890'
        const result = await runManagerAsync(['set', token, '--connect'], {
          pluginDataDir,
          env: {
            CLONE_MCP_URL: mcpUrl,
            CLONE_DASHBOARD_URL: 'https://dashboard.example',
          },
        })

        assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
        assert.equal(readStoredToken(pluginDataDir), token)
        assert.deepEqual(calls.map((call) => call.method), ['initialize', 'tools/call'])
        assert.equal(calls[1].apiKey, token)
        assert.equal(calls[1].params.arguments.source_detail, 'clone-loop:claude-code')
        assert.match(result.stdout, /Dashboard: https:\/\/dashboard\.example\/console\?session=clone-session-123#sources/)
        assert.doesNotMatch(result.stdout, new RegExp(token))
      })
    })
  })

  it('clears a plugin config token', () => {
    withPluginData((pluginDataDir) => {
      writeFileSync(
        join(pluginDataDir, 'auth.local.json'),
        `${JSON.stringify({ clone_api_token: 'clone_saved_token_1234567890' }, null, 2)}\n`,
      )

      const result = runManager(['clear'], { pluginDataDir })

      assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
      assert.equal(existsSync(join(pluginDataDir, 'auth.local.json')), false)
      assert.match(result.stdout, /Cleared plugin config API key/)
    })
  })

  it('stores plugin config under Codex PLUGIN_DATA when injected', () => {
    const pluginDataDir = mkdtempSync(join(tmpdir(), 'clone-codex-plugin-data-'))

    try {
      const token = 'clone_codex_saved_token_1234567890'
      const result = runManager(['set', token], {
        env: { PLUGIN_DATA: pluginDataDir },
      })

      assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
      const saved = JSON.parse(readFileSync(join(pluginDataDir, 'auth.local.json'), 'utf8'))
      assert.equal(saved.clone_api_token, token)
    } finally {
      rmSync(pluginDataDir, { recursive: true, force: true })
    }
  })
})
