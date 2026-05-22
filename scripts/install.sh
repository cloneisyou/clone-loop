#!/usr/bin/env bash
set -euo pipefail

GITHUB_REPO="cloneisyou/clone-loop"

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

if ! "${CLAUDE_BIN}" plugin marketplace add "${GITHUB_REPO}@main"; then
  echo "Marketplace add did not complete; refreshing clone-loop if it already exists."
  "${CLAUDE_BIN}" plugin marketplace update clone-loop || true
fi

if ! "${CLAUDE_BIN}" plugin install clone@clone-loop --scope user; then
  echo "Install did not complete; trying plugin update for an existing install."
  "${CLAUDE_BIN}" plugin update clone@clone-loop
fi

echo
if command -v gh >/dev/null 2>&1; then
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf "Star %s on GitHub now? [Y/n] " "${GITHUB_REPO}" > /dev/tty
    read -r STAR_REPLY < /dev/tty || STAR_REPLY=""
    case "${STAR_REPLY:-Y}" in
      n|N|no|NO|No)
        echo "Skipping GitHub star."
        ;;
      *)
        if gh repo star "${GITHUB_REPO}" >/dev/null 2>&1; then
          echo "Starred ${GITHUB_REPO}."
        else
          echo "Could not star automatically. Check GitHub CLI authentication with: gh auth status"
        fi
        ;;
    esac
  else
    echo "Skipping GitHub star prompt because no interactive terminal is available."
  fi
else
  echo "Skipping GitHub star prompt because GitHub CLI is not installed."
fi

cat <<'NEXT'

Clone is installed.

Open your agent and paste:
/clone:loop "Run tests and fix any failures" --max-iterations 5

Optional API key setup:
/clone:api-key status
NEXT
