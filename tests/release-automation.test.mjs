import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

function writeFixture(rootDir, path, contents) {
  const target = join(rootDir, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

describe('release automation', () => {
  it('bumps plugin version across manifest and hook clients', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'clone-release-fixture-'))

    try {
      writeFixture(
        fixtureRoot,
        '.claude-plugin/plugin.json',
        JSON.stringify({ name: 'clone', version: '0.2.7', description: 'Clone' }, null, 2),
      )
      writeFixture(fixtureRoot, 'hooks/stop-hook.mjs', "const CLIENT_VERSION = '0.2.7'\n")
      writeFixture(fixtureRoot, 'hooks/ask-user-question-hook.mjs', "const CLIENT_VERSION = '0.2.7'\n")

      const result = spawnSync(
        process.execPath,
        [join(root, 'scripts/bump-plugin-version.mjs'), '--root', fixtureRoot, '--part', 'minor'],
        { encoding: 'utf8' },
      )

      assert.equal(result.status, 0, result.stderr || result.stdout)
      assert.equal(JSON.parse(readFileSync(join(fixtureRoot, '.claude-plugin/plugin.json'), 'utf8')).version, '0.3.0')
      assert.match(readFileSync(join(fixtureRoot, 'hooks/stop-hook.mjs'), 'utf8'), /CLIENT_VERSION = '0\.3\.0'/)
      assert.match(readFileSync(join(fixtureRoot, 'hooks/ask-user-question-hook.mjs'), 'utf8'), /CLIENT_VERSION = '0\.3\.0'/)
      assert.match(result.stdout, /0\.2\.7 -> 0\.3\.0/)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })
})
