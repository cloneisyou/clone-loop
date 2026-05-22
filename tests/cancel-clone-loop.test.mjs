import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scriptPath = join(pluginRoot, 'scripts', 'cancel-clone-loop.mjs')

function runCancel(workdir) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: workdir,
    encoding: 'utf8',
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
})
