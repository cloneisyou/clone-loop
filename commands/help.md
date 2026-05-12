---
description: "Explain Clone Loop plugin and available commands"
---

# Clone Plugin Help

Please explain the following to the user:

## What is Clone Loop?

Clone Loop is a Clone-backed automation loop for Claude Code. It runs inside
the current session and uses Clone MCP to predict the user's likely next prompt
whenever Claude tries to stop.

**Core concept:**

1. Claude receives the user's initial task.
2. Claude works on the task, modifying files.
3. Claude tries to stop.
4. The Stop hook intercepts the stop.
5. The Stop hook calls Clone MCP `predict_next_prompt` directly.
6. If confidence clears the configured threshold, the hook passes the
   prediction payload to Claude.
7. Claude evaluates the prediction in context and continues as if the user had
   provided the predicted prompt.
8. The loop continues until max iterations are reached, confidence fails, MCP
   fails, or the user runs `/clone:cancel-loop`.

During an active loop, Clone also watches `AskUserQuestion` and answers with a
predicted response so the user does not have to handle the popup manually.

## Available Commands

### /clone:loop

Start a Clone Loop in your current session.

**Usage:**

```bash
/clone:loop "Refactor the cache layer" --max-iterations 20
/clone:loop "Add tests" --clone-threshold 0.8
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

1. Nonblank `CLONE_API_TOKEN` from the Claude Code process environment.
2. Saved plugin config in `${CLAUDE_PLUGIN_DATA}/auth.local.json`.
3. The public demo fallback token.

Full tokens are never shown in command output.

### Human Escalation

If Clone MCP returns low confidence or fails, the hook removes
`.claude/clone-loop.local.md`. Claude should explain that Clone was not
confident enough and wait for human input.

## Learn More

- Clone docs: https://clone.is/you
