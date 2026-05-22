import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const setupPath = join(pluginRoot, 'scripts', 'setup-codex-loop.mjs')

function runSetup(homeDir, extraEnv = {}) {
  return spawnSync(process.execPath, [setupPath], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: join(homeDir, '.codex', 'plugins', 'data', 'clone-loop'),
      ...extraEnv,
    },
    encoding: 'utf8',
  })
}

describe('Codex Clone Loop setup', () => {
  it('creates Codex config with plugin hooks enabled', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'clone-codex-setup-'))

    try {
      const result = runSetup(homeDir)

      assert.equal(result.status, 0, result.stderr)
      const config = readFileSync(join(homeDir, '.codex', 'config.toml'), 'utf8')
      assert.match(config, /\[features\]/)
      assert.match(config, /plugin_hooks = true/)
      assert.equal(existsSync(join(homeDir, '.codex', 'config.toml.clone-loop.bak')), false)
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('preserves existing config and writes one backup before updating', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'clone-codex-setup-existing-'))
    const codexDir = join(homeDir, '.codex')

    try {
      mkdirSync(codexDir, { recursive: true })
      writeFileSync(
        join(codexDir, 'config.toml'),
        'model = "gpt-5.4"\n\n[features]\nweb_search = true\n',
      )

      const first = runSetup(homeDir)
      const second = runSetup(homeDir)

      assert.equal(first.status, 0, first.stderr)
      assert.equal(second.status, 0, second.stderr)

      const config = readFileSync(join(codexDir, 'config.toml'), 'utf8')
      assert.match(config, /model = "gpt-5\.4"/)
      assert.match(config, /web_search = true/)
      assert.equal((config.match(/\[features\]/g) || []).length, 1)
      assert.equal((config.match(/plugin_hooks = true/g) || []).length, 1)

      const backup = readFileSync(join(codexDir, 'config.toml.clone-loop.bak'), 'utf8')
      assert.match(backup, /web_search = true/)
      assert.doesNotMatch(backup, /plugin_hooks = true/)
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
})
