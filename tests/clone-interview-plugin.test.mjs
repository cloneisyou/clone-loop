import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

function read(path) {
  return readFileSync(join(root, path), 'utf8')
}

describe('Clone Interview plugin surface', () => {
  it('publishes a Claude /clone:interview command backed by the setup script', () => {
    const command = read('commands/interview.md')

    assert.match(command, /description: "Clarify a goal into a Clone Interview plan"/)
    assert.match(command, /argument-hint: "TOPIC \[--max-questions N\] \[--mode quick\|deep\] \[--output PATH\]"/)
    assert.match(command, /setup-clone-interview\.mjs/)
    assert.match(command, /AskUserQuestion/)
    assert.match(command, /Ask one question at a time/)
    assert.match(command, /Current understanding/)
    assert.match(command, /Blocked decision/)
    assert.match(command, /Plan impact/)
    assert.match(command, /Readiness Audit/)
    assert.match(command, /executable plan/)
  })

  it('publishes a Codex clone-interview skill with plugin-only interview rules', () => {
    const skillPath = join(root, 'skills', 'clone-interview', 'SKILL.md')
    assert.equal(existsSync(skillPath), true)

    const skill = read('skills/clone-interview/SKILL.md')
    assert.match(skill, /name: clone-interview/)
    assert.match(skill, /setup-clone-interview\.mjs/)
    assert.match(skill, /predict-interview-answer\.mjs/)
    assert.match(skill, /Inspect repository facts first/)
    assert.match(skill, /decision: "auto"/)
    assert.match(skill, /decision: "escalate"/)
    assert.match(skill, /Current understanding/)
    assert.match(skill, /Blocked decision/)
    assert.match(skill, /Plan impact/)
    assert.match(skill, /Readiness Audit/)
    assert.match(skill, /plugin-only for question generation/)
  })

  it('documents Clone Interview in help, README, hooks, and Codex default prompts', () => {
    const claudeHelp = read('commands/help.md')
    const codexHelp = read('skills/clone-help/SKILL.md')
    const readme = read('README.md')
    const hooks = read('hooks/hooks.json')
    const codexManifest = JSON.parse(read('.codex-plugin/plugin.json'))

    assert.match(claudeHelp, /\/clone:interview/)
    assert.match(codexHelp, /clone-interview/)
    assert.match(hooks, /interview-question-hook\.mjs/)
    assert.match(readme, /\/clone:interview "<topic>"/)
    assert.match(readme, /Clone Interview is the goal-to-plan side of Clone/)
    assert.match(readme, /Goal Contract/)
    assert.match(readme, /Plan Draft/)
    assert.match(readme, /Readiness Audit/)
    assert.match(readme, /Low-confidence questions escalate to you/)
    assert.ok(
      codexManifest.interface.defaultPrompt.some((prompt) => /Clone Interview/.test(prompt)),
      'Codex default prompts mention Clone Interview',
    )
  })
})
