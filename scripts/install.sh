#!/usr/bin/env bash
set -euo pipefail

if command -v claude >/dev/null 2>&1; then
  CLAUDE_BIN="claude"
elif command -v claude.exe >/dev/null 2>&1; then
  CLAUDE_BIN="claude.exe"
else
  echo "Clone install failed: Claude Code CLI was not found on PATH." >&2
  echo "Install Claude Code, then rerun this installer." >&2
  exit 1
fi

echo "Installing Clone with ${CLAUDE_BIN}..."

if ! "${CLAUDE_BIN}" plugin marketplace add cloneisyou/clone-loop@main; then
  echo "Marketplace add did not complete; refreshing clone-labs if it already exists."
  "${CLAUDE_BIN}" plugin marketplace update clone-labs || true
fi

if ! "${CLAUDE_BIN}" plugin install clone@clone-labs --scope user; then
  echo "Install did not complete; trying plugin update for an existing install."
  "${CLAUDE_BIN}" plugin update clone@clone-labs
fi

cat <<'NEXT'

Clone is installed.

Open your agent and paste:
/clone:loop "Run tests and fix any failures" --max-iterations 5

Optional API key setup:
/clone:api-key status
NEXT
