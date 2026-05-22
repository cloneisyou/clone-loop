import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const setupPath = join(pluginRoot, 'scripts', 'setup-clone-loop.mjs')
const ANSI_BOLD = '\u001b[1m'
const ANSI_PURPLE = '\u001b[35m'
const ANSI_RESET = '\u001b[0m'

function runSetupAsync(workdir, args, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [setupPath, ...args], {
      cwd: workdir,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CLONE_API_TOKEN: 'test-token',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolveRun({ status, stdout, stderr }))
  })
}

describe('Clone Loop setup script', () => {
  it('runs with Node only and writes loop state', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-loop-setup-'))

    try {
      const result = spawnSync(
        process.execPath,
        [
          setupPath,
          'launcher smoke test',
          '--max-iterations',
          '1',
        ],
        {
          cwd: workdir,
          env: {
            ...process.env,
            CLAUDE_PLUGIN_ROOT: pluginRoot,
          },
          encoding: 'utf8',
        },
      )

      assert.equal(
        result.status,
        0,
        JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2),
      )
      assert.match(result.stdout, /Clone Loop activated/)
      assert.ok(
        result.stdout.includes(`${ANSI_BOLD}${ANSI_PURPLE}Iteration 1 : launcher smoke test${ANSI_RESET}`),
        result.stdout,
      )

      const state = readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8')
      assert.match(state, /launcher smoke test/)
      assert.match(state, /max_iterations: 1/)
      assert.match(state, /clone_threshold: 0\.6/)
      assert.doesNotMatch(state, /completion_promise/)
      assert.doesNotMatch(state, /clone_k/)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('rejects removed public loop options', () => {
    for (const option of ['--completion-promise', '--clone-k']) {
      const workdir = mkdtempSync(join(tmpdir(), 'clone-loop-setup-'))

      try {
        const result = spawnSync(
          process.execPath,
          [setupPath, 'launcher smoke test', option, '1'],
          {
            cwd: workdir,
            env: {
              ...process.env,
              CLAUDE_PLUGIN_ROOT: pluginRoot,
            },
            encoding: 'utf8',
          },
        )

        assert.notEqual(result.status, 0, `${option} should fail`)
        assert.match(result.stderr, /Unknown option/)
      } finally {
        rmSync(workdir, { recursive: true, force: true })
      }
    }
  })

  it('uses Codex thread identity when started from Codex', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-loop-setup-codex-'))

    try {
      const result = spawnSync(
        process.execPath,
        [setupPath, 'codex launcher smoke test'],
        {
          cwd: workdir,
          env: {
            ...process.env,
            PLUGIN_ROOT: pluginRoot,
            CODEX_THREAD_ID: 'codex-thread-123',
          },
          encoding: 'utf8',
        },
      )

      assert.equal(result.status, 0, result.stderr)
      const state = readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8')
      assert.match(state, /session_id: codex-thread-123/)
      assert.match(state, /clone_agent: "Codex Clone Loop"/)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('starts a Clone MCP session and records the initial prompt', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-loop-setup-mcp-'))

    try {
      const calls = []
      const server = createServer(async (req, res) => {
        let body = ''
        req.setEncoding('utf8')
        for await (const chunk of req) body += chunk
        const payload = JSON.parse(body)
        calls.push({ method: payload.method, params: payload.params, headers: req.headers })
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream')
        if (payload.method === 'initialize') {
          res.setHeader('mcp-session-id', 'mcp-session-setup')
          res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { capabilities: {} } })}\n\n`)
          return
        }
        const toolName = payload.params?.name
        const bodyValue = toolName === 'start_session'
          ? { session_id: 'clone-session-setup' }
          : { event_id: 'prompt-event-setup' }
        res.end(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result: { content: [{ type: 'text', text: JSON.stringify(bodyValue) }] },
          })}\n\n`,
        )
      })
      await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
      const { port } = server.address()
      try {
        const result = await runSetupAsync(
          workdir,
          ['bootstrap mcp memory'],
          { CLONE_MCP_URL: `http://127.0.0.1:${port}/mcp` },
        )

        assert.equal(result.status, 0, JSON.stringify(result))
        const state = readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8')
        assert.match(state, /clone_session_id: "clone-session-setup"/)
        assert.match(state, /mcp_session_id: "mcp-session-setup"/)
        assert.match(state, /last_prompt_event_id: "prompt-event-setup"/)
        assert.equal(calls.some((call) => call.params?.name === 'start_session'), true)
        assert.equal(calls.some((call) => call.params?.name === 'record_agent_prompt'), true)
      } finally {
        await new Promise((resolveClose) => server.close(resolveClose))
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })
})
