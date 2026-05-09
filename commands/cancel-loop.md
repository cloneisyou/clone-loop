---
description: "Cancel active Clone Loop"
allowed-tools: ["Bash(test -f .claude/clone-loop.local.md:*)", "Bash(rm .claude/clone-loop.local.md)", "Read(.claude/clone-loop.local.md)"]
hide-from-slash-command-tool: "true"
---

# Cancel Clone Loop

To cancel the active Clone Loop:

1. Check if `.claude/clone-loop.local.md` exists using Bash: `test -f .claude/clone-loop.local.md && echo "EXISTS" || echo "NOT_FOUND"`

2. **If NOT_FOUND**: Say "No active Clone Loop found."

3. **If EXISTS**:
   - Read `.claude/clone-loop.local.md` to get the current iteration number from the `iteration:` field
   - Remove the file using Bash: `rm .claude/clone-loop.local.md`
   - Report: "Cancelled Clone Loop (was at iteration N)" where N is the iteration value
