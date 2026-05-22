import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { withCloneMcpServer } from './helpers/clone-mcp-server.mjs'

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
      await withCloneMcpServer(
        {
          start_session: () => ({ session_id: 'clone-session-setup' }),
          record_agent_prompt: () => ({ event_id: 'prompt-event-setup' }),
        },
        async (endpoint, calls) => {
          const result = await runSetupAsync(
            workdir,
            ['bootstrap mcp memory'],
            { CLONE_MCP_URL: endpoint },
          )

          assert.equal(result.status, 0, JSON.stringify(result))
          const state = readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8')
          assert.match(state, /clone_session_id: "clone-session-setup"/)
          assert.match(state, /mcp_session_id: "mcp-session-setup"/)
          assert.match(state, /last_prompt_event_id: "prompt-event-setup"/)
          const startCall = calls.find((call) => call.params?.name === 'start_session')
          assert.ok(startCall)
          assert.equal(startCall.params.arguments.source_detail, 'clone:loop')
          assert.equal(calls.some((call) => call.params?.name === 'record_agent_prompt'), true)
        },
        { sessionId: 'mcp-session-setup' },
      )
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })
})
