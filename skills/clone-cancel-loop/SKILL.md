---
name: clone-cancel-loop
description: Cancel the active Clone Loop in the current workspace.
---

# Clone Cancel Loop

Use this skill when the user asks to cancel or stop the active Clone Loop.

Check for `.claude/clone-loop.local.md` in the current workspace. If it does not exist, say there is no active Clone Loop. If it exists, read the `iteration:` field, remove the file, and report the cancelled iteration.

Use shell commands equivalent to:

```bash
test -f .claude/clone-loop.local.md && echo EXISTS || echo NOT_FOUND
rm .claude/clone-loop.local.md
```
