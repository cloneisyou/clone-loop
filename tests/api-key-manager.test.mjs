import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scriptPath = join(pluginRoot, 'scripts', 'manage-api-key.mjs')

function runManager(args, options = {}) {
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: options.pluginDataDir,
    ...(options.env || {}),
  }
  delete env.CLONE_API_TOKEN
  if (options.env && Object.hasOwn(options.env, 'CLONE_API_TOKEN')) {
    env.CLONE_API_TOKEN = options.env.CLONE_API_TOKEN
  }

  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd || pluginRoot,
    env,
    encoding: 'utf8',
  })
}

function withPluginData(callback) {
  const pluginDataDir = mkdtempSync(join(tmpdir(), 'clone-plugin-data-'))
  try {
    return callback(pluginDataDir)
  } finally {
    rmSync(pluginDataDir, { recursive: true, force: true })
  }
}

function readStoredToken(pluginDataDir) {
  const data = JSON.parse(readFileSync(join(pluginDataDir, 'auth.local.json'), 'utf8'))
  return data.clone_api_token
}

describe('Clone API key manager', () => {
  it('reports demo fallback status when no env token or plugin config exists', () => {
    withPluginData((pluginDataDir) => {
      const result = runManager(['status'], { pluginDataDir })

      assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
      assert.match(result.stdout, /Source: demo fallback/)
      assert.match(result.stdout, /Token: clone_yc.*\.\.\..*2026/)
      assert.doesNotMatch(result.stdout, /clone_yc-reviewer-public-demo-2026/)
    })
  })

  it('imports CLONE_API_TOKEN into plugin data without printing the full token', () => {
    withPluginData((pluginDataDir) => {
      const token = 'clone_import_env_token_1234567890'
      const result = runManager(['import-env'], {
        pluginDataDir,
        env: { CLONE_API_TOKEN: token },
      })

      assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
      assert.equal(readStoredToken(pluginDataDir), token)
      assert.match(result.stdout, /Stored Clone API key from CLONE_API_TOKEN/)
      assert.doesNotMatch(result.stdout, new RegExp(token))
    })
  })

  it('clears a plugin config token', () => {
    withPluginData((pluginDataDir) => {
      writeFileSync(
        join(pluginDataDir, 'auth.local.json'),
        `${JSON.stringify({ clone_api_token: 'clone_saved_token_1234567890' }, null, 2)}\n`,
      )

      const result = runManager(['clear'], { pluginDataDir })

      assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
      assert.equal(existsSync(join(pluginDataDir, 'auth.local.json')), false)
      assert.match(result.stdout, /Cleared plugin config API key/)
    })
  })

  it('stores plugin config under Codex PLUGIN_DATA when injected', () => {
    const pluginDataDir = mkdtempSync(join(tmpdir(), 'clone-codex-plugin-data-'))

    try {
      const token = 'clone_codex_saved_token_1234567890'
      const result = runManager(['set', token], {
        env: { PLUGIN_DATA: pluginDataDir },
      })

      assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
      const saved = JSON.parse(readFileSync(join(pluginDataDir, 'auth.local.json'), 'utf8'))
      assert.equal(saved.clone_api_token, token)
    } finally {
      rmSync(pluginDataDir, { recursive: true, force: true })
    }
  })
})
