---
description: "Explain Clone Loop plugin and available commands"
---

# Clone Plugin Help

Please explain the following to the user:

## What is Clone Loop?

Clone Loop is a Clone-backed version of Anthropic's Ralph Loop technique. It keeps the same in-session Stop hook mechanism, but each continuation is predicted by Clone MCP instead of simply repeating the original prompt.

**Core concept:**

The loop runs inside the current Claude Code session:

1. Claude receives the user's initial task.
2. Claude works on the task, modifying files.
3. Claude tries to stop.
4. The Stop hook intercepts the stop.
5. Claude calls `mcp__clone__predict_next_prompt`.
6. If Clone is confident enough, Claude treats `predicted_response` as the next user prompt.
7. The loop continues until the completion promise is detected or the max iteration limit is reached.

The self-reference still comes from Claude seeing previous file changes and git history, just like Ralph Loop. Clone adds personalized next-prompt prediction between iterations.

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

If Clone MCP returns low confidence, escalates, or fails, Claude should remove `.claude/clone-loop.local.md`, explain that Clone was not confident enough, and wait for human input.

## Learn More

- Official Anthropic Ralph Loop plugin: https://claude.com/plugins/ralph-loop
- Original Ralph technique: https://ghuntley.com/ralph/
