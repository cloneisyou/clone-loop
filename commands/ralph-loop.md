---
description: "Legacy alias for /clone:loop"
argument-hint: "PROMPT [--max-iterations N] [--completion-promise TEXT] [--clone-threshold N] [--clone-k N]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/setup-ralph-loop.sh:*)"]
hide-from-slash-command-tool: "true"
---

# Legacy Clone Loop Alias

`/clone:loop` is the preferred command. This legacy Ralph-compatible command
uses the same setup script so the vendored upstream command surface remains
available.

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/setup-ralph-loop.sh" $ARGUMENTS
```

Please work on the task.

When you try to exit, the Clone Loop stop hook will block the stop, ask Clone MCP (`mcp__clone__predict_next_prompt`) to predict the next user prompt, and continue only when Clone is confident enough. You will still see your previous work in files and git history, allowing you to iterate and improve.

CRITICAL RULE: If a completion promise is set, you may ONLY output it when the statement is completely and unequivocally TRUE. Do not output false promises to escape the loop, even if you think you're stuck or should exit for other reasons. The loop is designed to continue until genuine completion.
