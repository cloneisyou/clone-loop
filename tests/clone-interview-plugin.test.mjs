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

    assert.match(command, /description: "Clarify requirements into a Clone Interview spec"/)
    assert.match(command, /argument-hint: "TOPIC \[--max-questions N\] \[--mode quick\|deep\] \[--output PATH\]"/)
    assert.match(command, /setup-clone-interview\.mjs/)
    assert.match(command, /Ask one question at a time/)
    assert.match(command, /one-sentence goal/)
  })

  it('publishes a Codex clone-interview skill with plugin-only interview rules', () => {
    const skillPath = join(root, 'skills', 'clone-interview', 'SKILL.md')
    assert.equal(existsSync(skillPath), true)

    const skill = read('skills/clone-interview/SKILL.md')
    assert.match(skill, /name: clone-interview/)
    assert.match(skill, /setup-clone-interview\.mjs/)
    assert.match(skill, /Inspect repository facts first/)
    assert.match(skill, /Ask the user for goals/)
    assert.match(skill, /Clone Interview v1 is plugin-only/)
  })

  it('documents Clone Interview in help, README, and Codex default prompts', () => {
    const claudeHelp = read('commands/help.md')
    const codexHelp = read('skills/clone-help/SKILL.md')
    const readme = read('README.md')
    const codexManifest = JSON.parse(read('.codex-plugin/plugin.json'))

    assert.match(claudeHelp, /\/clone:interview/)
    assert.match(codexHelp, /clone-interview/)
    assert.match(readme, /\/clone:interview "<topic>"/)
    assert.match(readme, /Clone Interview is the requirements side of Clone/)
    assert.ok(
      codexManifest.interface.defaultPrompt.some((prompt) => /Clone Interview/.test(prompt)),
      'Codex default prompts mention Clone Interview',
    )
  })
})
