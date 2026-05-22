---
name: clone-loop
description: Start a Clone Loop in Codex so Stop hooks can continue with Clone-predicted next prompts.
---

# Clone Loop

Use this skill when the user asks to start Clone Loop, run the Claude `/clone:loop ...` equivalent in Codex, or keep Codex working with Clone-predicted next prompts.

Run the setup script with the user's task and options:

```bash
node "${PLUGIN_ROOT}/scripts/setup-clone-loop.mjs" $ARGUMENTS
```

If setup succeeds, work on the task from the user's original prompt. When Codex tries to stop, the bundled Stop hook asks Clone MCP for the likely next prompt and continues only when confidence clears the configured threshold.

Supported options:

- `--max-iterations <n>`: stop after N loop continuations, `0` for unlimited.
- `--clone-threshold <n>`: confidence threshold in `[0, 1]`, default `0.6`.
- `--clone-agent <text>`: advanced agent label sent to Clone.

If the Stop hook does not run, ask the user to run the `clone-setup` skill and review `/hooks` so Codex trusts the plugin hook.
