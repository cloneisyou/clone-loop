# Clone

**Keep Claude Code working — even when it wants to stop.**

Clone is a Claude Code plugin that turns any task into a self-driving loop.
When Claude tries to stop, Clone predicts your most likely next prompt and
hands it back to Claude so the work continues — without you having to type
the same nudge ten times.

```text
/clone:loop "Build a REST API for todos. CRUD, validation, tests." --max-iterations 20
```

Then walk away.

## Why people use it

- **Stop typing "yes, keep going."** Clone predicts the obvious next step and
  injects it for you. Threshold-gated so it only auto-continues when it's
  confident.
- **Rich context, not a one-line snapshot.** Each prediction sees the original
  task, every prior iteration's user turn, and a full timeline of what
  Claude did this iteration — text, tool calls, and tool results.
- **AskUserQuestion popups answered automatically** during an active loop.
- **One session, one Claude.** No subprocesses, no parallel agents to herd.
  The loop runs inside your existing Claude Code session.

## Quick start

```bash
claude plugin marketplace add cloneisyou/clone-claude-plugin@main
claude plugin install clone@clone-labs --scope user
```

Inside Claude Code:

```text
/clone:api-key status
/clone:loop "Run tests and fix any failures" --max-iterations 5
```

Cancel anytime with `/clone:cancel-loop`.

> [!NOTE]
> Clone ships with a public demo API key so you can try the loop in seconds.
> For private memory and your own prediction quality, set `CLONE_API_TOKEN`
> and run `/clone:api-key import-env`.

## Commands

| Command | What it does |
|---|---|
| `/clone:loop "<task>" [options]` | Start a loop. |
| `/clone:cancel-loop` | Cancel the active loop. |
| `/clone:api-key status\|import-env\|set\|clear` | Manage your Clone API key. |
| `/clone:help` | Show command help. |

### Options

- `--max-iterations <n>` — stop after N iterations (`0` = unlimited). Start
  small (5–10) while you tune the prompt.
- `--clone-threshold <n>` — confidence threshold in `[0, 1]`. Default `0.8`.
  Below threshold, Clone hands control back to you.
- `--clone-agent "<label>"` — advanced; agent label sent to Clone.

## How it works

1. `/clone:loop` writes a state file and you ask Claude to start the task.
2. Claude works. When it tries to stop, the Stop hook intercepts.
3. The hook asks Clone MCP `predict_next_prompt` for what you'd most likely
   say next.
4. **Above the threshold** → Clone's prediction is injected and Claude
   continues.  **Below** → the loop ends and asks for human input.
5. Mid-loop `AskUserQuestion` popups are auto-answered the same way.

That's it. No subprocesses, no daemons, no parallel agents.

## What Clone actually sees

Each prediction is built from three sections so Clone has the context to
predict like you:

- **Your original task prompt** — always preserved verbatim.
- **The conversation so far** — every prior iteration's injected user turn
  plus the assistant timeline that produced it (text + tool calls +
  summarized tool results).
- **What Claude just did** — this iteration's full timeline.

Sane caps: 20-turn rolling window on user history, oldest prior-iter
timelines drop first when the combined size would exceed the budget, and
long tool outputs are summarized head + tail. The original prompt and the
freshest iteration are never trimmed.

## API key

Token resolution: `CLONE_API_TOKEN` env var → plugin config
(`${CLAUDE_PLUGIN_DATA}/auth.local.json`) → public demo fallback.

Recommended setup:

```bash
export CLONE_API_TOKEN="clone_xxx"   # or $env:CLONE_API_TOKEN on PowerShell
claude
```

Then:

```text
/clone:api-key import-env
/clone:api-key status
```

Prefer `import-env` over `/clone:api-key set <key>` — slash-command
arguments can stick around in transcripts.

> [!WARNING]
> The demo key is public and shared. Don't use it with private memory.

## Requirements

- Claude Code with plugin support.
- Node.js on `PATH`.
- Windows: PowerShell or cmd, no Git Bash needed.

## Plugin structure

```text
.claude-plugin/plugin.json       Plugin metadata.
commands/                        Slash command definitions.
hooks/stop-hook.mjs              Intercepts stop, calls Clone MCP.
hooks/ask-user-question-hook.mjs Auto-answers popups during a loop.
scripts/conversation-context.mjs Builds the multi-turn agent_input.
scripts/clone-auth.mjs           Token resolution.
scripts/manage-api-key.mjs       /clone:api-key implementation.
scripts/setup-clone-loop.mjs     /clone:loop state writer.
```

`.mcp.json` registers the remote Clone MCP endpoint with
`X-Clone-API-Key` interpolation:

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

## Development

```bash
pnpm test                      # unit + integration tests
pnpm run test:mcp:e2e          # live Clone MCP smoke (uses demo token if unset)
node scripts/manual-e2e-multiturn.mjs   # manual rich-context probe
claude plugin validate .
```

> [!IMPORTANT]
> Live MCP tests hit the remote Clone endpoint. Don't record sensitive data
> against the demo fallback.

## Installing & updating

```bash
# install
claude plugin marketplace add cloneisyou/clone-claude-plugin@main
claude plugin install clone@clone-labs --scope user

# update
claude plugin marketplace update clone-labs
claude plugin update clone@clone-labs
```

PowerShell users: same commands with `claude.exe`.

For a pinned, session-only checkout:

```bash
git clone https://github.com/cloneisyou/clone-claude-plugin.git
cd clone-claude-plugin
claude --plugin-dir .
```

Pin a frozen version by replacing `main` with `clone-plugin-v0.3.0` (current)
or `clone-plugin-v0.2.7` (previous).

> [!NOTE]
> The `clone-labs` marketplace is hosted from this repo — not the official
> Anthropic `claude-plugins-official` marketplace.

## License

Apache-2.0.
