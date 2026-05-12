---
description: "Start a Clone Loop in the current session"
argument-hint: "PROMPT [--max-iterations N] [--clone-threshold N] [--clone-agent TEXT]"
allowed-tools: Bash(node *setup-clone-loop.mjs*)
hide-from-slash-command-tool: "true"
---

# Clone Loop Command

Use the Bash tool to execute the Node setup script and initialize the Clone Loop:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-clone-loop.mjs" $ARGUMENTS
```

If setup succeeds, please work on the task.

When you try to exit, the Clone Loop stop hook will block the stop, call Clone MCP directly to predict the next user prompt, and pass the prediction to you only when it clears the configured confidence threshold. You will still see your previous work in files and git history, allowing you to iterate and improve.
