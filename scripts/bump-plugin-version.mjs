import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/
const VALID_PARTS = new Set(['major', 'minor', 'patch'])

function usage() {
  return `Usage: node scripts/bump-plugin-version.mjs [--root <path>] [--part major|minor|patch | --set x.y.z]`
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    part: 'patch',
    setVersion: null,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--root') {
      options.root = argv[++index]
    } else if (arg.startsWith('--root=')) {
      options.root = arg.slice('--root='.length)
    } else if (arg === '--part') {
      options.part = argv[++index]
    } else if (arg.startsWith('--part=')) {
      options.part = arg.slice('--part='.length)
    } else if (arg === '--set') {
      options.setVersion = argv[++index]
    } else if (arg.startsWith('--set=')) {
      options.setVersion = arg.slice('--set='.length)
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`)
    }
  }

  if (!options.root) throw new Error(`Missing --root value\n${usage()}`)
  if (!VALID_PARTS.has(options.part)) throw new Error(`Invalid --part value: ${options.part}\n${usage()}`)
  if (options.setVersion && !VERSION_PATTERN.test(options.setVersion)) {
    throw new Error(`Invalid --set version: ${options.setVersion}\n${usage()}`)
  }

  return {
    ...options,
    root: resolve(options.root),
  }
}

function bumpVersion(version, part) {
  const match = VERSION_PATTERN.exec(version)
  if (!match) throw new Error(`Invalid current plugin version: ${version}`)

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])

  if (part === 'major') return `${major + 1}.0.0`
  if (part === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function replaceOnce(contents, pattern, replacement, label) {
  if (!pattern.test(contents)) throw new Error(`Could not find ${label}`)
  return contents.replace(pattern, replacement)
}

function updateJsonVersion(path, nextVersion) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  const previousVersion = manifest.version
  manifest.version = nextVersion
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return previousVersion
}

function updateClientVersion(path, nextVersion) {
  const contents = readFileSync(path, 'utf8')
  writeFileSync(
    path,
    replaceOnce(
      contents,
      /const CLIENT_VERSION = '\d+\.\d+\.\d+'/,
      `const CLIENT_VERSION = '${nextVersion}'`,
      `${path} CLIENT_VERSION`,
    ),
  )
}

const options = parseArgs(process.argv.slice(2))
const manifestPath = join(options.root, '.claude-plugin', 'plugin.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const previousVersion = manifest.version
const nextVersion = options.setVersion || bumpVersion(previousVersion, options.part)

if (nextVersion === previousVersion) {
  throw new Error(`Next version matches current version: ${nextVersion}`)
}

updateJsonVersion(manifestPath, nextVersion)
const codexManifestPath = join(options.root, '.codex-plugin', 'plugin.json')
if (existsSync(codexManifestPath)) {
  updateJsonVersion(codexManifestPath, nextVersion)
}
updateClientVersion(join(options.root, 'hooks', 'stop-hook.mjs'), nextVersion)
updateClientVersion(join(options.root, 'hooks', 'ask-user-question-hook.mjs'), nextVersion)
updateClientVersion(join(options.root, 'scripts', 'predict-interview-answer.mjs'), nextVersion)

console.log(`clone plugin version: ${previousVersion} -> ${nextVersion}`)
