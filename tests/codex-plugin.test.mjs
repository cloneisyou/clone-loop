import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'))
}

describe('Codex plugin manifest', () => {
  it('publishes this repo as the clone-loop Codex plugin', () => {
    const manifest = readJson('.codex-plugin/plugin.json')

    assert.equal(manifest.name, 'clone-loop')
    assert.equal(manifest.version, readJson('.claude-plugin/plugin.json').version)
    assert.equal(manifest.repository, 'https://github.com/cloneisyou/clone-loop')
    assert.equal(manifest.license, 'Apache-2.0')
    assert.equal(manifest.mcpServers, './.mcp.json')
    assert.equal(manifest.interface.displayName, 'Clone Loop')
    assert.match(manifest.interface.shortDescription, /predicted next prompts/i)
    assert.ok(manifest.interface.defaultPrompt.length <= 3)
  })

  it('registers a repo-local Codex marketplace entry named clone-loop', () => {
    const marketplace = readJson('.agents/plugins/marketplace.json')
    const [entry] = marketplace.plugins

    assert.equal(marketplace.name, 'clone-loop')
    assert.equal(marketplace.interface.displayName, 'Clone Loop')
    assert.equal(entry.name, 'clone-loop')
    assert.deepEqual(entry.source, { source: 'local', path: '../..' })
    assert.deepEqual(entry.policy, {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    })
    assert.equal(entry.category, 'Productivity')
  })
})
