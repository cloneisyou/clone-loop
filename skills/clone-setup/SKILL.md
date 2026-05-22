---
name: clone-setup
description: Enable Codex plugin hooks and report Clone Loop setup status.
---

# Clone Setup

Use this skill before the first Codex Clone Loop run, or when Clone Loop hooks do not fire.

Run:

```bash
node "${PLUGIN_ROOT}/scripts/setup-codex-loop.mjs"
```

Report whether Codex plugin hooks are enabled, which Clone API key source is active, and whether the shared demo fallback is being used. If Codex says hooks need trust review, tell the user to open `/hooks`, trust the Clone Loop plugin hooks, and retry the loop.
