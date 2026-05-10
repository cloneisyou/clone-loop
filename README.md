# Clone

Clone is a Claude Code plugin that runs Clone Loop: a Ralph-style automation
loop upgraded with Clone MCP next-prompt prediction.

It vendors Anthropic's official `ralph-loop` plugin, keeps the same Stop hook
lifecycle, and changes one key thing: instead of replaying the same prompt,
Clone Loop asks Clone what the user would probably say next.

Based on Anthropic Ralph Loop, modified by Clone. The included Ralph Loop code
is licensed under Apache-2.0; see `LICENSE`.

## Why Clone Loop

Ralph Loop keeps Claude Code working by replaying the original task whenever
Claude tries to stop.

```mermaid
flowchart TD
  R1["User starts Ralph Loop with one task"]
  R2["Claude works on files"]
  R3["Claude tries to stop"]
  R4["Stop hook blocks"]
  R5["Same original prompt is replayed"]
  R6["Claude continues in the same session"]

  R1 --> R2 --> R3 --> R4 --> R5 --> R6
```

Clone Loop keeps the same loop, but replaces "repeat the same prompt" with
"ask Clone what the user would probably say next."

```mermaid
flowchart TD
  C1["User starts Clone Loop with one task"]
  C2["Claude works on files"]
  C3["Claude tries to stop"]
  C4["Stop hook blocks"]
  C5["Hook calls Clone MCP predict_next_prompt"]
  C6{"confidence >= user threshold?"}
  C7["Pass prediction payload to Claude"]
  C8["Claude evaluates it in context and continues"]
  C9["Escalate to the human"]

  C1 --> C2 --> C3 --> C4 --> C5 --> C6
  C6 -->|yes| C7 --> C8
  C6 -->|no| C9
```

| Area | Ralph Loop | Clone Loop |
| --- | --- | --- |
| Next instruction | Same original prompt | Hook-mediated Clone prediction |
| Personalization | None | User memory through `predict_next_prompt` |
| Safety | Max iterations and completion promise | Same checks plus confidence threshold and MCP failure escalation |

## Plugin Structure

The original Ralph Loop files are kept for compatibility:

```text
.claude-plugin/plugin.json     Plugin metadata for Claude Code.
commands/ralph-loop.md         Starts the loop by running the setup script.
commands/cancel-ralph.md       Removes the loop state file.
commands/help.md               Explains Ralph Loop to the user.
hooks/hooks.json               Registers a Stop hook.
hooks/stop-hook.sh             Blocks stop and re-injects the prompt.
scripts/setup-ralph-loop.sh    Parses options and writes loop state.
README.md                      User documentation.
LICENSE                        Apache-2.0 license from Ralph Loop.
```

Clone adds `/clone:loop`, `/clone:cancel-loop`, `.claude/clone-loop.local.md`,
and Clone MCP prediction settings (`--clone-threshold`, `--clone-k`,
`--clone-agent`).

## Versions

> [!Tip]
> Use `0.2.x` unless you specifically need to compare against v1. v2 is the
> hook-mediated path that calls Clone MCP directly from the Stop hook.

- `0.1.x` / v1: Claude-mediated MCP. The Stop hook asked Claude to call
  `mcp__clone__predict_next_prompt`.
- `0.2.x` / v2: hook-mediated MCP. The Stop hook calls Clone MCP directly,
  gates only on the user-configured confidence threshold, then passes the
  prediction payload to Claude for continuation.

## Requirements

- Claude Code with plugin support.
- `CLONE_API_TOKEN` exported in the shell that launches Claude Code.
- Optional Claude MCP permission for manual `mcp__clone__predict_next_prompt`
  calls. The v2 loop path calls Clone MCP directly from the Stop hook.

Runtime shell requirements differ by OS:

- macOS / Linux: `bash`, `node`, `perl`, `sed`, and `awk` must be on `PATH`.
- Windows: Git for Windows is required, and `bash` should resolve to
  `C:\Program Files\Git\bin\bash.exe` rather than WSL's
  `C:\Windows\System32\bash.exe`.

Ralph Loop uses `jq` for JSON parsing. Clone Loop uses Node instead, so Windows
does not need a separate `jq` install when Git Bash is present.

> [!Important]
> On Windows, `bash` must resolve to Git Bash. If it resolves to WSL, the hook
> may not see the same filesystem paths or Node installation that Claude Code
> sees.

Clone's direct remote MCP endpoint is registered in `.mcp.json`:

```json
{
  "mcpServers": {
    "clone": {
      "url": "https://api.clone.is/mcp",
      "headers": {
        "X-Clone-API-Key": "${CLONE_API_TOKEN}"
      }
    }
  }
}
```

Smithery can also manage the same server:

```bash
smithery mcp add clone/clone --headers '{"cloneApiKey":"your-clone-api-key"}'
```

The plugin defaults to the direct endpoint so Claude Code only needs
`CLONE_API_TOKEN`.

## OS Setup

> [!Note]
> These commands only prepare the environment and validate the plugin. For
> installation commands, jump to [Installation Commands](#installation-commands).

### macOS / Linux

```bash
export CLONE_API_TOKEN="clone_yc-reviewer-public-demo-2026"
command -v bash node perl sed awk
claude plugin validate .
```

### Windows

```powershell
$env:CLONE_API_TOKEN = "clone_yc-reviewer-public-demo-2026"
Get-Command bash
Get-Command node
Get-Command perl
Get-Command sed
Get-Command awk
claude.exe plugin validate .
```

`Get-Command bash` should point to Git Bash:

```text
C:\Program Files\Git\bin\bash.exe
```

If it points to `C:\Windows\System32\bash.exe`, Claude Code may try to use WSL.
Fix `PATH` so Git Bash comes first, or edit the installed plugin cache
`hooks/hooks.json` to use Git Bash explicitly:

```json
"command": "\"C:/Program Files/Git/bin/bash.exe\" \"${CLAUDE_PLUGIN_ROOT}/hooks/stop-hook.sh\""
```

## Usage

> [!Tip]
> Start with a small `--max-iterations` value while testing the loop. Increase
> it once the prompt and completion promise are behaving well.

Start Clone Loop:

```bash
/clone:loop "Build a REST API for todos. Requirements: CRUD operations, validation, tests. Output <promise>COMPLETE</promise> when done." --completion-promise "COMPLETE" --max-iterations 20
```

Recommended options:

```bash
/clone:loop "Fix the auth bug and run tests" \
  --max-iterations 10 \
  --completion-promise "COMPLETE" \
  --clone-threshold 0.8 \
  --clone-k 1
```

Cancel the loop:

```bash
/clone:cancel-loop
```

## How It Works

1. `/clone:loop` writes `.claude/clone-loop.local.md`.
2. Claude works on the task.
3. When Claude tries to stop, `hooks/stop-hook.sh` runs.
4. The hook keeps Ralph safety checks: session isolation, corrupted-state
   cleanup, max iterations, and completion promise.
5. If the loop continues, the hook calls Clone MCP `predict_next_prompt`
   directly with the original prompt, iteration, threshold, and
   `last_assistant_message`.
6. If confidence clears the user-configured threshold, the hook passes the
   prediction payload to Claude. Claude evaluates it in context and continues
   as if the user had provided the predicted prompt.
7. If confidence is too low or MCP fails, the loop state is removed and the
   human is asked to continue.

## Options

- `--max-iterations <n>`: stop after N iterations. `0` means unlimited.
- `--completion-promise <text>`: phrase that must appear inside
  `<promise>...</promise>` to complete the loop.
- `--clone-threshold <n>`: Clone confidence threshold in `[0, 1]`; default
  `0.8`.
- `--clone-k <n>`: number of Clone candidate prompts to request, `1-10`;
  default `1`.
- `--clone-agent <text>`: agent label sent to Clone; default
  `Claude Code Clone Loop`.

## Prompt Guidance

Use explicit success criteria and automated verification:

```markdown
Implement feature X using TDD.

Success criteria:
- Tests cover happy path and failure path
- `npm test` passes
- README documents the new command
- Output <promise>COMPLETE</promise> only when all criteria are true
```

Always set a reasonable `--max-iterations`.

## Development

> [!Important]
> `npm run test:mcp` calls the live Clone MCP endpoint. The test uses the public
> YC reviewer demo key by default, so do not record sensitive data there.

macOS / Linux:

```bash
npm test
npm run test:mcp
```

Windows PowerShell:

```powershell
npm test
npm run test:mcp
```

To test another account:

```bash
export CLONE_API_TOKEN="clone_xxx"
npm run test:mcp
```

```powershell
$env:CLONE_API_TOKEN = "clone_xxx"
npm run test:mcp
```

Validate with Claude Code on macOS / Linux:

```bash
claude plugin validate .
```

Validate with Claude Code on Windows:

```powershell
claude.exe plugin validate .
```

## Installation Commands

> [!Tip]
> Use v2 by default. It is the hook-mediated Clone MCP version.

> [!Note]
> This repository contains only the Clone Claude Code plugin. The main Clone
> monorepo consumes it as a git submodule.

### macOS / Linux: GitHub Marketplace Install

```bash
export CLONE_API_TOKEN="clone_yc-reviewer-public-demo-2026"
claude plugin marketplace add cloneisyou/clone-claude-plugin@main
claude plugin install clone@clone-labs --scope user
claude
```

Then run inside Claude Code:

```text
/clone:loop "Run tests and fix any failures" --max-iterations 5 --clone-threshold 0.8
```

### Windows PowerShell: GitHub Marketplace Install

```powershell
$env:CLONE_API_TOKEN = "clone_yc-reviewer-public-demo-2026"
claude.exe plugin marketplace add cloneisyou/clone-claude-plugin@main
claude.exe plugin install clone@clone-labs --scope user
claude.exe
```

Then run inside Claude Code:

```text
/clone:loop "Run tests and fix any failures" --max-iterations 5 --clone-threshold 0.8
```

> [!Note]
> Session-only mode is best for trying a local checkout without changing your
> Claude Code plugin configuration.

### macOS / Linux: Session-Only

```bash
git clone https://github.com/cloneisyou/clone-claude-plugin.git
cd clone-claude-plugin
git checkout main
export CLONE_API_TOKEN="clone_yc-reviewer-public-demo-2026"
claude --plugin-dir .
```

Then run inside Claude Code:

```text
/clone:loop "Run tests and fix any failures" --max-iterations 5 --clone-threshold 0.8
```

### Windows PowerShell: Session-Only

```powershell
git clone https://github.com/cloneisyou/clone-claude-plugin.git
Set-Location clone-claude-plugin
git checkout main
$env:CLONE_API_TOKEN = "clone_yc-reviewer-public-demo-2026"
claude.exe --plugin-dir .
```

Then run inside Claude Code:

```text
/clone:loop "Run tests and fix any failures" --max-iterations 5 --clone-threshold 0.8
```

### Local Checkout Marketplace Install

Use this only while developing the plugin from a local clone.

```bash
git clone https://github.com/cloneisyou/clone-claude-plugin.git
cd clone-claude-plugin
git checkout main
export CLONE_API_TOKEN="clone_yc-reviewer-public-demo-2026"
claude plugin marketplace add . --scope user
claude plugin install clone@clone-labs --scope user
```

```powershell
git clone https://github.com/cloneisyou/clone-claude-plugin.git
Set-Location clone-claude-plugin
git checkout main
$env:CLONE_API_TOKEN = "clone_yc-reviewer-public-demo-2026"
claude.exe plugin marketplace add . --scope user
claude.exe plugin install clone@clone-labs --scope user
```

### Published Plugin

> [!Note]
> These commands apply after Clone is published to a Claude plugin marketplace.

After Clone is published to the Claude plugin directory:

```bash
claude plugin install clone@claude-plugins-official --scope user
```

```powershell
claude.exe plugin install clone@claude-plugins-official --scope user
```

To pin a frozen version for session-only use, replace `main` with
`clone-plugin-v0.2.0` for v2 or `clone-plugin-v0.1.0` for v1.

> [!Warning]
> The demo API key is public and shared. Do not use it for private memory or
> sensitive project data.
