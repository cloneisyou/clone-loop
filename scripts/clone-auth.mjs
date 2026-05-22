import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { nowIso } from './clone-utils.mjs'

export const DEMO_TOKEN = 'clone_yc-reviewer-public-demo-2026'
export const AUTH_FILE_NAME = 'auth.local.json'

export function defaultPluginDataDir() {
  return join(homedir(), '.claude', 'plugins', 'data', 'clone-loop-clone-labs')
}

function legacyPluginDataDirs() {
  return [
    join(homedir(), '.claude', 'plugins', 'data', 'clone-clone-loop'),
    join(homedir(), '.claude', 'plugins', 'data', 'clone-clone-labs'),
  ]
}

export function pluginDataDir(env = process.env) {
  const codexValue = String(env.PLUGIN_DATA || '').trim()
  if (codexValue) return codexValue
  const value = String(env.CLAUDE_PLUGIN_DATA || '').trim()
  return value || defaultPluginDataDir()
}

export function isPluginDataDirInjected(env = process.env) {
  return Boolean(String(env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA || '').trim())
}

export function authFilePath(env = process.env) {
  const dir = pluginDataDir(env)
  return dir ? join(dir, AUTH_FILE_NAME) : ''
}

function authFileCandidates(env = process.env) {
  const primary = authFilePath(env)
  if (isPluginDataDirInjected(env)) return primary ? [primary] : []
  return [primary, ...legacyPluginDataDirs().map((dir) => join(dir, AUTH_FILE_NAME))].filter(Boolean)
}

export function maskToken(token) {
  const value = String(token || '').trim()
  if (!value) return ''
  if (value.length <= 10) return `${value.slice(0, 2)}...${value.slice(-2)}`
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}

export function readPluginConfigToken(env = process.env) {
  for (const file of authFileCandidates(env)) {
    if (!existsSync(file)) continue

    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const token = String(parsed.clone_api_token || '').trim()
      if (token) return token
    } catch {
      // Keep checking legacy auth files.
    }
  }
  return null
}

export function writePluginConfigToken(token, env = process.env) {
  const value = String(token || '').trim()
  if (!value) throw new Error('Clone API key must not be empty.')

  const dir = pluginDataDir(env)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    authFilePath(env),
    `${JSON.stringify(
      {
        clone_api_token: value,
        updated_at: nowIso(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
}

export function clearPluginConfigToken(env = process.env) {
  const file = authFilePath(env)
  if (!file) return false
  const existed = existsSync(file)
  rmSync(file, { force: true })
  return existed
}

export function resolveCloneToken(env = process.env) {
  const envToken = String(env.CLONE_API_TOKEN || '').trim()
  if (envToken) {
    return {
      token: envToken,
      source: 'environment',
      masked: maskToken(envToken),
      isDemo: false,
    }
  }

  const pluginToken = readPluginConfigToken(env)
  if (pluginToken) {
    return {
      token: pluginToken,
      source: 'plugin config',
      masked: maskToken(pluginToken),
      isDemo: false,
    }
  }

  return {
    token: DEMO_TOKEN,
    source: 'demo fallback',
    masked: maskToken(DEMO_TOKEN),
    isDemo: true,
  }
}
