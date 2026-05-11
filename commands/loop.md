---
description: "Start a Clone Loop in the current session"
argument-hint: "PROMPT [--max-iterations N] [--completion-promise TEXT] [--clone-threshold N] [--clone-k N]"
allowed-tools: Bash(bash *setup-clone-loop.sh*)
hide-from-slash-command-tool: "true"
---

# Clone Loop Command

Use the Bash tool to execute the setup script and initialize the Clone Loop:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-clone-loop.sh" $ARGUMENTS
```

If setup succeeds, please work on the task.

When you try to exit, the Clone Loop stop hook will block the stop, call Clone MCP directly to predict the next user prompt, and pass the prediction to you only when it clears the configured confidence threshold. You will still see your previous work in files and git history, allowing you to iterate and improve.

CRITICAL RULE: If a completion promise is set, you may ONLY output it when the statement is completely and unequivocally TRUE. Do not output false promises to escape the loop, even if you think you're stuck or should exit for other reasons. The loop is designed to continue until genuine completion.
