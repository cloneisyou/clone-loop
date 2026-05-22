import { isAbsolute, relative, resolve } from 'node:path'

export const CLAUDE_DIR = '.claude'
export const LOOP_STATE_FILE = 'clone-loop.local.md'
export const LOOP_HISTORY_FILE = 'clone-loop.history.local.jsonl'
export const INTERVIEW_STATE_FILE = 'clone-interview.local.md'
export const INTERVIEW_HISTORY_FILE = 'clone-interview.history.local.jsonl'
export const DEFAULT_INTERVIEW_OUTPUT_PATH = `${CLAUDE_DIR}/${INTERVIEW_STATE_FILE}`

export function claudeDir(root = process.cwd()) {
  return resolve(root, CLAUDE_DIR)
}

export function loopStatePath(root = process.cwd()) {
  return resolve(claudeDir(root), LOOP_STATE_FILE)
}

export function loopHistoryPath(root = process.cwd()) {
  return resolve(claudeDir(root), LOOP_HISTORY_FILE)
}

export function interviewStatePath(root = process.cwd()) {
  return resolve(claudeDir(root), INTERVIEW_STATE_FILE)
}

export function interviewHistoryPath(root = process.cwd()) {
  return resolve(claudeDir(root), INTERVIEW_HISTORY_FILE)
}

export function projectLocalPath(root, path) {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const display = relative(root, resolved) || '.'
  return {
    display,
    isInsideProject: !(display.startsWith('..') || isAbsolute(display)),
    resolved,
  }
}
