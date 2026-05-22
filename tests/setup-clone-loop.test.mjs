import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const setupPath = join(pluginRoot, 'scripts', 'setup-clone-loop.mjs')
const ANSI_BOLD = '\u001b[1m'
const ANSI_PURPLE = '\u001b[35m'
const ANSI_RESET = '\u001b[0m'

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
})
