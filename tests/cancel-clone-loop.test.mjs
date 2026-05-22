import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { withCloneMcpServer } from './helpers/clone-mcp-server.mjs'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scriptPath = join(pluginRoot, 'scripts', 'cancel-clone-loop.mjs')

function runCancel(workdir) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: workdir,
    encoding: 'utf8',
  })
}

function runCancelAsync(workdir, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: workdir,
      env: { ...process.env, CLONE_API_TOKEN: 'test-token', ...env },
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

describe('Clone Loop cancel script', () => {
  it('reports no active loop when state is absent', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-loop-cancel-empty-'))

    try {
      const result = runCancel(workdir)

      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /No active Clone Loop found/)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('removes active loop state and records cancellation history', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-loop-cancel-'))
    const claudeDir = join(workdir, '.claude')

    try {
      mkdirSync(claudeDir, { recursive: true })
      writeFileSync(
        join(claudeDir, 'clone-loop.local.md'),
        `---
active: true
iteration: 7
session_id: "session-123"
---

Original task
`,
      )

      const result = runCancel(workdir)

      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Cancelled Clone Loop \(was at iteration 7\)/)
      assert.equal(existsSync(join(claudeDir, 'clone-loop.local.md')), false)

      const history = readFileSync(join(claudeDir, 'clone-loop.history.local.jsonl'), 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line))
      assert.equal(history.length, 1)
      assert.equal(history[0].event, 'loop-cancel')
      assert.equal(history[0].iteration, '7')
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('stops active Clone MCP session before removing state', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-loop-cancel-mcp-'))
    const claudeDir = join(workdir, '.claude')

    try {
      mkdirSync(claudeDir, { recursive: true })
      writeFileSync(
        join(claudeDir, 'clone-loop.local.md'),
        `---
active: true
iteration: 2
session_id: "session-123"
clone_session_id: "clone-sess-cancel"
mcp_session_id: "mcp-sess-cancel"
---

Original task
`,
      )

      await withCloneMcpServer(
        { stop_session: () => ({ ok: true }) },
        async (endpoint, calls) => {
          const result = await runCancelAsync(workdir, { CLONE_MCP_URL: endpoint })

          assert.equal(result.status, 0, JSON.stringify(result))
          const stopCall = calls.find((call) => call.params?.name === 'stop_session')
          assert.ok(stopCall)
          assert.equal(stopCall.params.arguments.session_id, 'clone-sess-cancel')
          assert.equal(existsSync(join(claudeDir, 'clone-loop.local.md')), false)
        },
      )
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })
})
