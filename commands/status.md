---
description: "Show active Clone Loop status"
allowed-tools: ["Bash(test -f .claude/clone-loop.local.md:*)", "Read(.claude/clone-loop.local.md)"]
hide-from-slash-command-tool: "true"
---

# Clone Loop Status

To report the active Clone Loop status:

1. Check if `.claude/clone-loop.local.md` exists using Bash: `test -f .claude/clone-loop.local.md && echo "EXISTS" || echo "NOT_FOUND"`

2. **If NOT_FOUND**: Say "No active Clone Loop."

3. **If EXISTS**:
   - Read `.claude/clone-loop.local.md`
   - Report each frontmatter field on its own line in this order: `iteration`, `max_iterations`, `completion_promise`, `clone_threshold`, `clone_k`, `clone_agent`, `started_at`, `session_id`. Render `null` values as `none`.
   - After the fields, show the original loop prompt under a `Prompt:` header in a fenced code block.
   - Do not modify the file.
