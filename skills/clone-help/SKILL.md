---
name: clone-help
description: Explain Clone Loop usage in Codex.
---

# Clone Help

Explain the Codex Clone Loop commands:

- `clone-setup`: enable Codex plugin hooks and show API key status.
- `clone-loop "<task>" --max-iterations 5`: start a confidence-gated loop.
- `clone-api-key status|import-env|set <key>|clear`: manage the Clone API key.
- `clone-cancel-loop`: cancel the active loop.

Mention that Codex v1 reproduces the Stop-hook loop behavior. Claude's AskUserQuestion auto-answer hook is not available in Codex v1 because Codex does not expose an equivalent AskUserQuestion tool hook event.
