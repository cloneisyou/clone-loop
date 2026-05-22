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

  it('uses clone-loop for package and Clone MCP client identity', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const stopHook = readFileSync(join(root, 'hooks', 'stop-hook.mjs'), 'utf8')
    const askHook = readFileSync(join(root, 'hooks', 'ask-user-question-hook.mjs'), 'utf8')

    assert.equal(pkg.name, 'clone-loop-tests')
    assert.match(stopHook, /clientInfo: \{ name: 'clone-loop'/)
    assert.match(askHook, /clientInfo: \{ name: 'clone-loop'/)
  })
})
