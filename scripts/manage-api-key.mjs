#!/usr/bin/env node

import {
  authFilePath,
  clearPluginConfigToken,
  isPluginDataDirInjected,
  maskToken,
  pluginDataDir,
  resolveCloneToken,
  writePluginConfigToken,
} from './clone-auth.mjs'

const args = process.argv.slice(2)
const command = args[0] || 'status'

function usage() {
  console.log(`Clone API key manager

USAGE:
  /clone:api-key status
  /clone:api-key import-env
  /clone:api-key set <key>
  /clone:api-key clear

TOKEN PRIORITY:
  1. CLONE_API_TOKEN environment variable
  2. Plugin config in CLAUDE_PLUGIN_DATA/auth.local.json
  3. Public demo fallback token`)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function printResolvedToken(prefix = '') {
  const resolved = resolveCloneToken()
  if (prefix) console.log(prefix)
  console.log(`Source: ${resolved.source}`)
  console.log(`Token: ${resolved.masked}`)

  const injected = isPluginDataDirInjected()
  if (injected) {
    console.log(`Plugin config: ${authFilePath()}`)
  } else {
    console.log(`Plugin config: ${authFilePath()} (fallback path — CLAUDE_PLUGIN_DATA not injected)`)
  }

  if (resolved.isDemo) {
    console.log('Using the shared public demo fallback. Configure your own key for private Clone memory.')
  }
}

if (command === '-h' || command === '--help' || command === 'help') {
  usage()
  process.exit(0)
}

if (command === 'status') {
  printResolvedToken()
  process.exit(0)
}

if (command === 'import-env') {
  if (args.length !== 1) fail('Usage: /clone:api-key import-env')
  const token = String(process.env.CLONE_API_TOKEN || '').trim()
  if (!token) fail('CLONE_API_TOKEN is not set in this Claude Code process.')

  writePluginConfigToken(token)
  console.log('Stored Clone API key from CLONE_API_TOKEN.')
  console.log(`Token: ${maskToken(token)}`)
  console.log(`Plugin config: ${authFilePath()}`)
  process.exit(0)
}

if (command === 'set') {
  if (args.length !== 2 || !String(args[1] || '').trim()) {
    fail('Usage: /clone:api-key set <key>')
  }

  const token = String(args[1]).trim()
  writePluginConfigToken(token)
  console.log('Stored Clone API key in plugin config.')
  console.log(`Token: ${maskToken(token)}`)
  console.log(`Plugin config: ${authFilePath()}`)
  console.log('Prefer import-env when possible because direct slash-command arguments may remain in the transcript.')
  process.exit(0)
}

if (command === 'clear') {
  if (args.length !== 1) fail('Usage: /clone:api-key clear')
  clearPluginConfigToken()
  console.log('Cleared plugin config API key.')
  printResolvedToken('Current effective token:')
  process.exit(0)
}

fail(`Unknown /clone:api-key command: ${command}`)
