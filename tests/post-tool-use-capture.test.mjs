import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const hookPath = join(pluginRoot, 'scripts', 'capture-tool-use.mjs')

function writeState(workdir, overrides = {}) {
  const { writeLoopStart = true, ...stateOverrides } = overrides
  const state = {
    iteration: 2,
    max_iterations: 5,
    session_id: 'session-123',
    clone_threshold: 0.6,
    clone_agent: 'Claude Code Clone Loop',
    started_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    prompt: 'Ship the feature.',
    ...stateOverrides,
  }

  mkdirSync(join(workdir, '.claude'), { recursive: true })
  writeFileSync(
    join(workdir, '.claude', 'clone-loop.local.md'),
    `---
iteration: ${state.iteration}
max_iterations: ${state.max_iterations}
session_id: ${state.session_id}
clone_threshold: ${state.clone_threshold}
clone_agent: "${state.clone_agent}"
started_at: "${state.started_at}"
---
${state.prompt}
`,
  )
  if (writeLoopStart) {
    writeFileSync(
      join(workdir, '.claude', 'clone-loop.history.local.jsonl'),
      `${JSON.stringify({
        ts: state.started_at,
        event: 'loop-start',
        session_id: state.session_id,
        max_iterations: Number(state.max_iterations),
        clone_threshold: Number(state.clone_threshold),
        clone_agent: state.clone_agent,
        prompt: state.prompt,
      })}\n`,
    )
  }
}

function runHook(workdir, payload) {
  return spawnSync(process.execPath, [hookPath], {
    cwd: workdir,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
    input: JSON.stringify(payload),
    encoding: 'utf8',
  })
}

function readHistory(workdir) {
  const history = readFileSync(join(workdir, '.claude', 'clone-loop.history.local.jsonl'), 'utf8')
  return history
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe('PostToolUse capture hook', () => {
  it('records file mutation tool use during an active Clone Loop', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-post-tool-'))

    try {
      writeState(workdir)

      const result = runHook(workdir, {
        session_id: 'session-123',
        tool_name: 'Write',
        tool_input: {
          file_path: 'src/app.js',
          content: 'x'.repeat(400),
        },
        tool_response: {
          success: true,
        },
      })

      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, '')

      const record = readHistory(workdir).find((entry) => entry.event === 'post-tool-use')
      assert.ok(record)
      assert.equal(record.event, 'post-tool-use')
      assert.equal(record.iteration, 2)
      assert.equal(record.tool_name, 'Write')
      assert.equal(record.file_path, 'src/app.js')
      assert.equal(record.success, true)
      assert.match(record.summary, /Write src\/app\.js/)
      assert.doesNotMatch(JSON.stringify(record), /xxxxxxxxxxxxxxxxxxxxxxxx/)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('stays silent when no Clone Loop is active or the session differs', () => {
    const inactiveDir = mkdtempSync(join(tmpdir(), 'clone-post-tool-inactive-'))
    const mismatchDir = mkdtempSync(join(tmpdir(), 'clone-post-tool-mismatch-'))

    try {
      const inactive = runHook(inactiveDir, {
        session_id: 'session-123',
        tool_name: 'Edit',
        tool_input: { file_path: 'README.md' },
      })
      assert.equal(inactive.status, 0, inactive.stderr)
      assert.equal(inactive.stdout, '')
      assert.equal(existsSync(join(inactiveDir, '.claude', 'clone-loop.history.local.jsonl')), false)

      writeState(mismatchDir, { session_id: 'session-123' })
      const mismatch = runHook(mismatchDir, {
        session_id: 'different-session',
        tool_name: 'Edit',
        tool_input: { file_path: 'README.md' },
      })
      assert.equal(mismatch.status, 0, mismatch.stderr)
      assert.equal(mismatch.stdout, '')
      const mismatchHistory = readHistory(mismatchDir)
      assert.equal(mismatchHistory.some((entry) => entry.decision === 'stale-session-state'), true)
      assert.equal(existsSync(join(mismatchDir, '.claude', 'clone-loop.local.md')), false)
    } finally {
      rmSync(inactiveDir, { recursive: true, force: true })
      rmSync(mismatchDir, { recursive: true, force: true })
    }
  })

  it('does not capture tool use when loop-start is missing', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-post-tool-stale-'))

    try {
      writeState(workdir, { writeLoopStart: false })

      const result = runHook(workdir, {
        session_id: 'session-123',
        tool_name: 'Write',
        tool_input: { file_path: 'README.md' },
        tool_response: { success: true },
      })

      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, '')
      const history = readHistory(workdir)
      assert.equal(history.some((entry) => entry.decision === 'stale-missing-loop-start'), true)
      assert.equal(history.some((entry) => entry.event === 'post-tool-use' && entry.tool_name === 'Write'), false)
      assert.equal(existsSync(join(workdir, '.claude', 'clone-loop.local.md')), false)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })
})
