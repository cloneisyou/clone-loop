import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

function read(path) {
  return readFileSync(join(root, path), 'utf8')
}

function writeFixture(rootDir, path, contents) {
  const target = join(rootDir, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

describe('release automation', () => {
  it('bumps plugin version across manifest, hook clients, and README pins', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'clone-release-fixture-'))

    try {
      writeFixture(
        fixtureRoot,
        '.claude-plugin/plugin.json',
        JSON.stringify({ name: 'clone', version: '0.2.7', description: 'Clone' }, null, 2),
      )
      writeFixture(fixtureRoot, 'hooks/stop-hook.mjs', "const CLIENT_VERSION = '0.2.7'\n")
      writeFixture(fixtureRoot, 'hooks/ask-user-question-hook.mjs', "const CLIENT_VERSION = '0.2.7'\n")
      writeFixture(
        fixtureRoot,
        'README.md',
        'To pin a frozen version for session-only use, replace `main` with\n' +
          '`clone-plugin-v0.2.7` for the current release or `clone-plugin-v0.2.6` for the\n' +
          'previous release.\n',
      )

      const result = spawnSync(
        process.execPath,
        [join(root, 'scripts/bump-plugin-version.mjs'), '--root', fixtureRoot, '--part', 'minor'],
        { encoding: 'utf8' },
      )

      assert.equal(result.status, 0, result.stderr || result.stdout)
      assert.equal(JSON.parse(readFileSync(join(fixtureRoot, '.claude-plugin/plugin.json'), 'utf8')).version, '0.3.0')
      assert.match(readFileSync(join(fixtureRoot, 'hooks/stop-hook.mjs'), 'utf8'), /CLIENT_VERSION = '0\.3\.0'/)
      assert.match(readFileSync(join(fixtureRoot, 'hooks/ask-user-question-hook.mjs'), 'utf8'), /CLIENT_VERSION = '0\.3\.0'/)
      assert.match(readFileSync(join(fixtureRoot, 'README.md'), 'utf8'), /`clone-plugin-v0\.3\.0` for the current release/)
      assert.match(readFileSync(join(fixtureRoot, 'README.md'), 'utf8'), /`clone-plugin-v0\.2\.7` for the\s+previous release/)
      assert.match(result.stdout, /0\.2\.7 -> 0\.3\.0/)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('creates a minor release tag when a pull request is merged to main', () => {
    const workflow = read('.github/workflows/release-plugin.yml')

    assert.match(workflow, /pull_request_target:/)
    assert.match(workflow, /types: \[closed\]/)
    assert.match(workflow, /branches: \[main\]/)
    assert.match(workflow, /github\.event\.pull_request\.merged == true/)
    assert.match(workflow, /contents: write/)
    assert.match(workflow, /node scripts\/bump-plugin-version\.mjs --part minor/)
    assert.match(workflow, /TAG="clone-plugin-v\$\{VERSION\}"/)
    assert.match(workflow, /git push origin HEAD:main "\$TAG"/)
  })
})
