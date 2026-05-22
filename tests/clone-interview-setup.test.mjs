import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const setupPath = join(pluginRoot, 'scripts', 'setup-clone-interview.mjs')

function runInterview(workdir, args) {
  return spawnSync(process.execPath, [setupPath, ...args], {
    cwd: workdir,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PLUGIN_ROOT: pluginRoot,
    },
    encoding: 'utf8',
  })
}

describe('Clone Interview setup script', () => {
  it('runs with defaults and writes interview state plus history', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-interview-setup-'))

    try {
      const result = runInterview(workdir, ['Add', 'billing', 'to', 'the', 'app'])

      assert.equal(
        result.status,
        0,
        JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2),
      )
      assert.match(result.stdout, /Clone Interview started/)
      assert.match(result.stdout, /Mode: deep/)
      assert.match(result.stdout, /Max questions: 12/)

      const state = readFileSync(join(workdir, '.claude', 'clone-interview.local.md'), 'utf8')
      assert.match(state, /active: true/)
      assert.match(state, /topic: "Add billing to the app"/)
      assert.match(state, /mode: "deep"/)
      assert.match(state, /max_questions: 12/)
      assert.match(state, /question_count: 0/)
      assert.match(state, /output_path: "\.claude\/clone-interview\.local\.md"/)
      assert.match(state, /# Clone Interview/)
      assert.match(state, /\[from-code\]\[auto-confirmed\]/)

      const history = readFileSync(join(workdir, '.claude', 'clone-interview.history.local.jsonl'), 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line))
      assert.equal(history.length, 1)
      assert.equal(history[0].event, 'interview-start')
      assert.equal(history[0].topic, 'Add billing to the app')
      assert.equal(history[0].mode, 'deep')
      assert.equal(history[0].max_questions, 12)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('honors max questions, mode, and a custom project-local output path', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-interview-output-'))

    try {
      const result = runInterview(workdir, [
        'Improve',
        'onboarding',
        '--mode',
        'quick',
        '--max-questions',
        '5',
        '--output',
        'docs/clone-interview/onboarding.md',
      ])

      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Spec: docs\/clone-interview\/onboarding\.md/)

      const state = readFileSync(join(workdir, '.claude', 'clone-interview.local.md'), 'utf8')
      const output = readFileSync(join(workdir, 'docs', 'clone-interview', 'onboarding.md'), 'utf8')
      assert.equal(output, state)
      assert.match(state, /topic: "Improve onboarding"/)
      assert.match(state, /mode: "quick"/)
      assert.match(state, /max_questions: 5/)
      assert.match(state, /output_path: "docs\/clone-interview\/onboarding\.md"/)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('rejects invalid mode, invalid max questions, empty topics, and outside output paths', () => {
    const cases = [
      [['Feature', '--mode', 'medium'], /--mode must be quick or deep/],
      [['Feature', '--max-questions', '0'], /--max-questions requires a positive integer/],
      [['Feature', '--max-questions', 'abc'], /--max-questions requires a positive integer/],
      [['--mode', 'deep'], /No topic provided/],
      [['Feature', '--output', '../outside.md'], /--output must stay inside the current project/],
    ]

    for (const [args, expectedError] of cases) {
      const workdir = mkdtempSync(join(tmpdir(), 'clone-interview-invalid-'))

      try {
        const result = runInterview(workdir, args)
        assert.notEqual(result.status, 0, `${args.join(' ')} should fail`)
        assert.match(result.stderr, expectedError)
      } finally {
        rmSync(workdir, { recursive: true, force: true })
      }
    }
  })

  it('appends a new start event when rerun and refreshes frontmatter for the latest session', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-interview-rerun-'))

    try {
      assert.equal(runInterview(workdir, ['First', 'feature']).status, 0)
      assert.equal(runInterview(workdir, ['Second', 'feature', '--mode', 'quick']).status, 0)

      const state = readFileSync(join(workdir, '.claude', 'clone-interview.local.md'), 'utf8')
      assert.match(state, /topic: "Second feature"/)
      assert.match(state, /mode: "quick"/)
      assert.doesNotMatch(state, /topic: "First feature"/)

      const history = readFileSync(join(workdir, '.claude', 'clone-interview.history.local.jsonl'), 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line))
      assert.equal(history.length, 2)
      assert.equal(history[0].topic, 'First feature')
      assert.equal(history[1].topic, 'Second feature')
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })
})
