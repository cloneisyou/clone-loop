# Clone

Clone is a Claude Code plugin that runs Clone Loop: an automation loop powered
by Clone MCP next-prompt prediction.

Clone Loop keeps Claude Code working inside the same session. When Claude tries
to stop, the Stop hook calls Clone MCP, receives a predicted next prompt, and
continues only when the prediction clears the configured confidence threshold.
During an active loop, Clone can also answer `AskUserQuestion` so the user does
not have to handle the popup manually.

Loop prompts are rendered as prominent bold purple `Iteration N : <prompt>`
lines. `/clone:loop` prints the original user prompt as `Iteration 1`, and Stop
hook predictions are printed with their continuation iteration number whether
confidence clears the threshold or the loop escalates.

## Quick Install

Install from your shell:

```bash
claude plugin marketplace add cloneisyou/clone-claude-plugin@main
claude plugin install clone@clone-labs --scope user
```

If `clone-labs` is already added on this machine, the install command alone is
enough.

Or install from inside Claude Code:

```text
/plugin marketplace add cloneisyou/clone-claude-plugin@main
/plugin install clone@clone-labs
```

Then set your API key and start a loop:

```text
/clone:api-key status
/clone:loop "Run tests and fix any failures" --max-iterations 5 --clone-threshold 0.8
```

## API Key Setup

Clone Loop resolves tokens in this order:

1. `CLONE_API_TOKEN` environment variable, after trimming whitespace.
2. Plugin config in `${CLAUDE_PLUGIN_DATA}/auth.local.json`.
3. Public demo fallback token.

Unset or blank `CLONE_API_TOKEN` values are ignored, so Clone Loop falls through
to plugin config or the public demo fallback instead of sending an empty API
key.

The recommended setup is to export `CLONE_API_TOKEN`, start Claude Code, then
import that environment value into plugin data:

```bash
export CLONE_API_TOKEN="clone_xxx"
claude
```

```text
/clone:api-key import-env
/clone:api-key status
```

PowerShell:

```powershell
$env:CLONE_API_TOKEN = "clone_xxx"
claude.exe
```

```text
/clone:api-key import-env
/clone:api-key status
```

Useful API key commands:

```text
/clone:api-key status
/clone:api-key import-env
/clone:api-key set <key>
/clone:api-key clear
```

Prefer `import-env`. Direct `/clone:api-key set <key>` is convenient, but slash
command arguments may remain in the transcript. Command output always masks the
token and never prints the full value.

## Commands

- `/clone:loop`: start a Clone Loop.
- `/clone:api-key`: manage the Clone API key used by hooks.
- `/clone:cancel-loop`: cancel the active loop.
- `/clone:help`: show command help.

## Usage

Start Clone Loop:

```text
/clone:loop "Build a REST API for todos. Requirements: CRUD operations, validation, tests." --max-iterations 20
```

Recommended options:

```text
/clone:loop "Fix the auth bug and run tests" --max-iterations 10 --clone-threshold 0.8
```

Advanced agent label:

```text
/clone:loop "Refactor the cache layer" --max-iterations 5 --clone-agent "Claude Code Clone Loop"
```

Cancel the loop:

```text
/clone:cancel-loop
```

## Options

- `--max-iterations <n>`: stop after N iterations. `0` means unlimited.
- `--clone-threshold <n>`: Clone confidence threshold in `[0, 1]`; default
  `0.8`.
- `--clone-agent <text>`: advanced agent label sent to Clone; default
  `Claude Code Clone Loop`.

Start with a small `--max-iterations` value while testing the loop. Increase it
once the prompt is behaving well.

## How It Works

1. `/clone:loop` writes `.claude/clone-loop.local.md`.
2. Claude works on the task.
3. When Claude calls `AskUserQuestion`, the PreToolUse hook asks Clone MCP to
   predict the answer. If Clone MCP fails or cannot produce a prediction, the
   hook uses the first option as a fallback answer.
4. When Claude tries to stop, `hooks/stop-hook.mjs` runs.
5. The hook keeps Clone Loop safety checks: session isolation, corrupted-state
   cleanup, max iterations, confidence threshold, and MCP failure escalation.
6. If the loop continues, the hook calls Clone MCP `predict_next_prompt`
   directly with the original prompt, iteration, threshold, and
   `last_assistant_message`.
7. If confidence clears the user-configured threshold, the hook passes the
   prediction payload to Claude. Claude evaluates it in context and continues
   as if the user had provided the predicted prompt.
8. If confidence is too low or MCP fails, the loop state is removed and the
   human is asked to continue.

## Plugin Structure

```text
.claude-plugin/plugin.json       Plugin metadata for Claude Code.
commands/loop.md                 Starts Clone Loop with /clone:loop.
commands/api-key.md              Manages stored Clone API key config.
commands/cancel-loop.md          Cancels the active Clone Loop.
commands/help.md                 Explains Clone Loop to the user.
hooks/hooks.json                 Registers Stop and AskUserQuestion hooks.
hooks/stop-hook.mjs              Blocks stop and injects Clone predictions.
hooks/ask-user-question-hook.mjs Answers AskUserQuestion during active loops.
scripts/clone-auth.mjs           Resolves env, plugin config, and demo tokens.
scripts/manage-api-key.mjs       Implements /clone:api-key.
scripts/setup-clone-loop.mjs     Parses options and writes loop state.
README.md                        User documentation.
LICENSE                          Apache-2.0 license.
```

## Requirements

- Claude Code with plugin support.
- Node.js on `PATH`.
- Optional `CLONE_API_TOKEN` exported in the shell that launches Claude Code.
  If unset or blank and no plugin config token exists, Clone Loop uses the
  public demo fallback key.

Windows works from PowerShell or cmd. Git Bash is not required. Claude Code may
still label shell-tool calls as `Bash` in the UI, but Clone's runtime path
launches Node scripts directly.

Clone's direct remote MCP endpoint is registered in `.mcp.json`:

```json
{
  "mcpServers": {
    "clone": {
      "url": "https://api.clone.is/mcp",
      "headers": {
        "X-Clone-API-Key": "${CLONE_API_TOKEN:-clone_yc-reviewer-public-demo-2026}"
      }
    }
  }
}
```

The `.mcp.json` registration uses Claude Code environment interpolation. The
Clone Loop hooks also check plugin config through `${CLAUDE_PLUGIN_DATA}`.

## Development

> [!IMPORTANT]
> Live MCP tests call the remote Clone MCP endpoint. They use
> nonblank `CLONE_API_TOKEN` values when set and the public demo fallback
> otherwise. Do not record sensitive data with the demo fallback.

Run local tests:

```bash
npm test
npm run test:mcp:e2e
```

PowerShell:

```powershell
npm test
npm run test:mcp:e2e
```

Validate with Claude Code:

```bash
claude plugin validate .
```

```powershell
claude.exe plugin validate .
```

## Installation Commands

> [!IMPORTANT]
> The `clone-labs` marketplace below is the Clone Labs marketplace hosted from
> this GitHub repository. It is not the official Anthropic
> `claude-plugins-official` marketplace.

Plugin install IDs use `plugin@marketplace` order. For this repository, the
plugin is `clone` and the marketplace is `clone-labs`, so the install ID is
`clone@clone-labs`.

### macOS / Linux

```bash
claude plugin marketplace add cloneisyou/clone-claude-plugin@main
claude plugin install clone@clone-labs --scope user
claude
```

Inside Claude Code:

```text
/clone:api-key status
/clone:loop "Run tests and fix any failures" --max-iterations 5 --clone-threshold 0.8
```

### Windows PowerShell

```powershell
claude.exe plugin marketplace add cloneisyou/clone-claude-plugin@main
claude.exe plugin install clone@clone-labs --scope user
claude.exe
```

Inside Claude Code:

```text
/clone:api-key status
/clone:loop "Run tests and fix any failures" --max-iterations 5 --clone-threshold 0.8
```

### Updating

Refresh the marketplace catalog, then update the installed plugin:

```bash
claude plugin marketplace update clone-labs
claude plugin update clone@clone-labs
```

```powershell
claude.exe plugin marketplace update clone-labs
claude.exe plugin update clone@clone-labs
```

Because `.claude-plugin/plugin.json` declares an explicit plugin version,
release updates should bump that version before users run `claude plugin
update`.

### Session-Only Local Checkout

```bash
git clone https://github.com/cloneisyou/clone-claude-plugin.git
cd clone-claude-plugin
git checkout main
claude --plugin-dir .
```

```powershell
git clone https://github.com/cloneisyou/clone-claude-plugin.git
Set-Location clone-claude-plugin
git checkout main
claude.exe --plugin-dir .
```

To pin a frozen version for session-only use, replace `main` with
`clone-plugin-v0.2.7` for the current release or `clone-plugin-v0.2.6` for the
previous release.

> [!WARNING]
> The demo API key is public and shared. Do not use it for private memory or
> sensitive project data.
