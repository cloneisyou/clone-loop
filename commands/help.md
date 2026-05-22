---
description: "Explain Clone Loop plugin and available commands"
---

# Clone Plugin Help

Please explain the following to the user:

## What is Clone Loop?

Clone Loop is a Clone-backed automation loop for Claude Code and Codex. It runs
inside the current agent session and uses Clone MCP to predict the user's likely
next prompt whenever the agent tries to stop.

**Core concept:**

1. The agent receives the user's initial task.
2. The agent works on the task, modifying files.
3. The agent tries to stop.
4. The Stop hook intercepts the stop.
5. The Stop hook calls Clone MCP `predict_next_prompt` directly.
6. If confidence clears the configured threshold, the hook passes the
   prediction payload to the agent.
7. The agent evaluates the prediction in context and continues as if the user
   had provided the predicted prompt.
8. The loop continues until max iterations are reached, confidence fails, MCP
   fails, or the user runs `/clone:cancel-loop`.

In Claude Code, Clone also watches `AskUserQuestion` during an active loop and
answers with a predicted response so the user does not have to handle the popup
manually. Codex v1 does not expose an equivalent question hook.

## Available Commands

### /clone:interview

Clarify a vague requirement into a local Clone Interview spec before coding.

**Usage:**

```bash
/clone:interview "Add billing to the app"
/clone:interview "Improve onboarding" --mode quick --max-questions 5
/clone:interview "Build importer" --output docs/clone-interview/importer.md
```

Clone Interview is plugin-only in v1. It does not use Clone MCP as a question
generator. The agent inspects repo facts first, asks human-judgment questions
one at a time, and writes the working spec to
`.claude/clone-interview.local.md` unless `--output` is provided.

### /clone:loop

Start a Clone Loop in your current session.

**Usage:**

```bash
/clone:loop "Refactor the cache layer" --max-iterations 20
/clone:loop "Add tests" --clone-threshold 0.7
```

**Options:**

- `--max-iterations <n>` - Max iterations before auto-stop. `0` means unlimited.
- `--clone-threshold <n>` - Confidence threshold for auto-continuation.
- `--clone-agent <text>` - Advanced agent label sent to Clone.

### /clone:api-key

Manage the Clone API key used by Clone Loop.

**Usage:**

```bash
/clone:api-key status
/clone:api-key import-env
/clone:api-key clear
```

Token priority is nonblank `CLONE_API_TOKEN`, then plugin config, then demo fallback.
Prefer `import-env` over `set <key>` because direct slash-command arguments can
remain in the transcript.

### /clone:cancel-loop

Cancel an active Clone Loop.

**Usage:**

```bash
/clone:cancel-loop
```

## Key Concepts

### Token Sources

Clone Loop resolves API keys in this order:

1. Nonblank `CLONE_API_TOKEN` from the agent process environment.
2. Saved plugin config in `${CLAUDE_PLUGIN_DATA}/auth.local.json`.
3. The public demo fallback token.

Full tokens are never shown in command output.

### Human Escalation

If Clone MCP returns low confidence or fails, the hook removes
`.claude/clone-loop.local.md`. The agent should explain that Clone was not
confident enough and wait for human input.

## Learn More

- Clone docs: https://clone.is/you
