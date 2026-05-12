---
description: "Explain Clone Loop plugin and available commands"
---

# Clone Plugin Help

Please explain the following to the user:

## What is Clone Loop?

Clone Loop is a Clone-backed automation loop for Claude Code. It runs inside the current session and uses Clone MCP to predict the user's likely next prompt whenever Claude tries to stop.

**Core concept:**

The loop runs inside the current Claude Code session:

1. Claude receives the user's initial task.
2. Claude works on the task, modifying files.
3. Claude tries to stop.
4. The Stop hook intercepts the stop.
5. The Stop hook calls Clone MCP `predict_next_prompt` directly.
6. If confidence clears the configured threshold, the hook passes the prediction payload to Claude.
7. Claude evaluates the prediction in context and continues as if the user had provided the predicted prompt.
8. The loop continues until the completion promise is detected or the max iteration limit is reached.

During an active loop, Clone also watches `AskUserQuestion`. If Clone predicts
an answer with enough confidence and the answer maps to exactly one option, the
question is answered automatically. Otherwise Claude Code shows the normal
human question.

The self-reference comes from Claude seeing previous file changes and git history. Clone adds personalized next-prompt prediction between iterations.

## Available Commands

### /clone:loop

Start a Clone Loop in your current session.

**Usage:**

```bash
/clone:loop "Refactor the cache layer" --max-iterations 20
/clone:loop "Add tests" --completion-promise "TESTS COMPLETE"
```

**Options:**

- `--max-iterations <n>` - Max iterations before auto-stop.
- `--completion-promise <text>` - Promise phrase to signal completion.
- `--clone-threshold <n>` - Confidence threshold for auto-continuation.
- `--clone-k <n>` - Number of candidate prompts to request.
- `--clone-agent <text>` - Agent label sent to Clone.

### /clone:status

Show the active Clone Loop status without modifying it.

**Usage:**

```bash
/clone:status
```

Reports iteration, max iterations, completion promise, Clone threshold, k, agent, start time, session ID, and the original loop prompt. If no loop is active, reports that instead.

### /clone:cancel-loop

Cancel an active Clone Loop.

**Usage:**

```bash
/clone:cancel-loop
```

## Key Concepts

### Completion Promises

To signal completion, Claude must output a `<promise>...</promise>` tag whose text exactly matches the configured completion promise.

Without a completion promise or `--max-iterations`, Clone Loop can run indefinitely.

### Human Escalation

If Clone MCP returns low confidence or fails, the hook removes `.claude/clone-loop.local.md`. Claude should explain that Clone was not confident enough and wait for human input.

## Learn More

- Clone docs: https://clone.is/you
