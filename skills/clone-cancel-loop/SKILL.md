---
name: clone-cancel-loop
description: Cancel the active Clone Loop in the current workspace.
---

# Clone Cancel Loop

Use this skill when the user asks to cancel or stop the active Clone Loop.

Run the repo-local cancel script from the current workspace:

```sh
node "${PLUGIN_ROOT}/scripts/cancel-clone-loop.mjs"
```

The script checks `.claude/clone-loop.local.md`, removes it if present, records a `loop-cancel` history event, and reports the cancelled iteration.
