#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { authFilePath, isPluginDataDirInjected, resolveCloneToken } from './clone-auth.mjs'

const CODEX_DIR = join(homedir(), '.codex')
const CONFIG_PATH = join(CODEX_DIR, 'config.toml')
const BACKUP_PATH = `${CONFIG_PATH}.clone-loop.bak`

function lineEnding(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function ensurePluginHooksEnabled(raw) {
  const eol = lineEnding(raw)
  const lines = raw ? raw.split(/\r?\n/) : []
  let featureStart = -1
  let featureEnd = lines.length

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === '[features]') {
      featureStart = index
      break
    }
  }

  if (featureStart === -1) {
    const prefix = raw.trim() ? `${raw.trimEnd()}${eol}${eol}` : ''
    return `${prefix}[features]${eol}plugin_hooks = true${eol}`
  }

  for (let index = featureStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      featureEnd = index
      break
    }
  }

  for (let index = featureStart + 1; index < featureEnd; index += 1) {
    if (/^\s*plugin_hooks\s*=/.test(lines[index])) {
      if (/^\s*plugin_hooks\s*=\s*true\s*(?:#.*)?$/.test(lines[index])) {
        return raw.endsWith('\n') || raw.endsWith('\r\n') ? raw : `${raw}${eol}`
      }
      lines[index] = 'plugin_hooks = true'
      return `${lines.join(eol).replace(/[ \t]+$/gm, '').trimEnd()}${eol}`
    }
  }

  lines.splice(featureEnd, 0, 'plugin_hooks = true')
  return `${lines.join(eol).replace(/[ \t]+$/gm, '').trimEnd()}${eol}`
}

function main() {
  mkdirSync(CODEX_DIR, { recursive: true })

  const before = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : ''
  const after = ensurePluginHooksEnabled(before)

  if (after !== before) {
    if (before && !existsSync(BACKUP_PATH)) {
      writeFileSync(BACKUP_PATH, before)
    }
    writeFileSync(CONFIG_PATH, after)
    console.log('Enabled Codex plugin hooks: [features] plugin_hooks = true')
  } else {
    console.log('Codex plugin hooks already enabled.')
  }

  const resolved = resolveCloneToken()
  console.log(`Node: ${process.version}`)
  console.log(`PLUGIN_ROOT: ${process.env.PLUGIN_ROOT || '(not injected)'}`)
  console.log(`PLUGIN_DATA: ${process.env.PLUGIN_DATA || '(not injected)'}`)
  console.log(`Plugin config: ${authFilePath()}${isPluginDataDirInjected() ? '' : ' (fallback path)'}`)
  console.log(`Clone API key source: ${resolved.source}`)
  console.log(`Clone API key: ${resolved.masked}`)
  if (resolved.isDemo) {
    console.log('Using the shared public demo fallback. Set CLONE_API_TOKEN and run clone-api-key import-env for private Clone memory.')
  }
}

try {
  main()
} catch (error) {
  console.error(`Clone Codex setup failed: ${error?.message || String(error)}`)
  console.error(`Check ${CONFIG_PATH} manually and ensure this process can write to ~/.codex.`)
  process.exit(1)
}
