import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const capturePath = join(pluginRoot, 'scripts', 'capture-tool-use.mjs')

function writeState(workdir) {
  mkdirSync(join(workdir, '.claude'), { recursive: true })
  const startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  writeFileSync(
    join(workdir, '.claude', 'clone-loop.local.md'),
    `---
iteration: 1
max_iterations: 3
session_id: codex-session-123
clone_threshold: 0.6
clone_agent: "Codex Clone Loop"
started_at: "${startedAt}"
---
Patch the app.
`,
  )
  writeFileSync(
    join(workdir, '.claude', 'clone-loop.history.local.jsonl'),
    `${JSON.stringify({
      ts: startedAt,
      event: 'loop-start',
      session_id: 'codex-session-123',
      prompt: 'Patch the app.',
    })}\n`,
  )
}

describe('Codex PostToolUse capture', () => {
  it('records apply_patch file paths in Clone Loop history', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-codex-post-tool-'))

    try {
      writeState(workdir)
      const result = spawnSync(process.execPath, [capturePath], {
        cwd: workdir,
        env: {
          ...process.env,
          PLUGIN_ROOT: pluginRoot,
        },
        input: JSON.stringify({
          hook_event_name: 'PostToolUse',
          session_id: 'codex-session-123',
          tool_name: 'apply_patch',
          tool_input: {
            patch: `*** Begin Patch
*** Update File: src/app.js
@@
-old
+new
*** Add File: src/new.js
+export const ok = true
*** End Patch
`,
          },
          tool_response: {
            success: true,
            output: 'Success. Updated files.',
          },
        }),
        encoding: 'utf8',
      })

      assert.equal(result.status, 0, result.stderr)

      const records = readFileSync(join(workdir, '.claude', 'clone-loop.history.local.jsonl'), 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line))
      const event = records.at(-1)

      assert.equal(event.event, 'post-tool-use')
      assert.equal(event.tool_name, 'apply_patch')
      assert.equal(event.file_path, 'src/app.js, src/new.js')
      assert.match(event.summary, /apply_patch src\/app\.js, src\/new\.js/)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })
})
