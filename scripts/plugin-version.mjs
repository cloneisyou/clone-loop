import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_VERSION = '0.0.0'
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MANIFEST_PATHS = [
  join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'),
  join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'),
]

export function readPluginVersion() {
  for (const manifestPath of MANIFEST_PATHS) {
    if (!existsSync(manifestPath)) continue

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (typeof manifest.version === 'string' && manifest.version.trim()) {
        return manifest.version
      }
    } catch {}
  }

  return DEFAULT_VERSION
}

export const PLUGIN_VERSION = readPluginVersion()
