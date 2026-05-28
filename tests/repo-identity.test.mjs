import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ignoredDirs = new Set(['.git', '.claude', '.codex', 'node_modules'])
const oldSlug = ['clone', 'claude', 'plugin'].join('-')
const oldRepo = `cloneisyou/${oldSlug}`
const oldRawRepo = ['raw.githubusercontent.com', 'cloneisyou', oldSlug].join('/')

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function repoFiles(dir = root) {
  const files = []
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...repoFiles(path))
    } else {
      files.push(path)
    }
  }
  return files
}

describe('repository identity', () => {
  it('uses cloneisyou/clone-loop everywhere public repo identity appears', () => {
    const haystack = repoFiles()
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')

    assert.match(haystack, /cloneisyou\/clone-loop/)
    assert.doesNotMatch(haystack, new RegExp(escapeRegExp(oldRepo)))
    assert.doesNotMatch(haystack, new RegExp(escapeRegExp(oldRawRepo)))
  })

  it('publishes the Claude plugin as clone-loop in the clone-labs marketplace', () => {
    const marketplace = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'))

    assert.equal(marketplace.name, 'clone-labs')
    assert.equal(marketplace.plugins[0].name, 'clone-loop')
    assert.equal(manifest.name, 'clone-loop')
  })

  it('uses clone-loop for package and Clone MCP client identity', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const client = readFileSync(join(root, 'scripts', 'clone-mcp-client.mjs'), 'utf8')
    const stopHook = readFileSync(join(root, 'hooks', 'stop-hook.mjs'), 'utf8')
    const askHook = readFileSync(join(root, 'hooks', 'ask-user-question-hook.mjs'), 'utf8')
    const cloneMcp = readFileSync(join(root, 'scripts', 'clone-mcp.mjs'), 'utf8')

    assert.equal(pkg.name, 'clone-loop-tests')
    assert.match(client, /CLONE_MCP_CLIENT_NAME = 'clone-loop'/)
    assert.match(client, /PLUGIN_VERSION/)
    assert.match(stopHook, /from '\.\.\/scripts\/clone-mcp\.mjs'/)
    assert.match(askHook, /from '\.\.\/scripts\/clone-mcp\.mjs'/)
    assert.match(cloneMcp, /cloneMcpClientInfo/)
  })

  it('installer can automatically star clone-loop through GitHub CLI', () => {
    const installer = readFileSync(join(root, 'scripts', 'install.sh'), 'utf8')

    assert.match(installer, /GITHUB_REPO="cloneisyou\/clone-loop"/)
    assert.match(installer, /gh repo star "\$\{GITHUB_REPO\}"/)
    assert.doesNotMatch(installer, /Star .* now\?/)
    assert.doesNotMatch(installer, /STAR_REPLY/)
    assert.doesNotMatch(installer, /echo "  gh repo star/)
  })

  it('keeps shell installers LF-only so bash can parse them on every OS', () => {
    const installer = readFileSync(join(root, 'scripts', 'install.sh'), 'utf8')

    assert.doesNotMatch(installer, /\r\n/)
  })
})
