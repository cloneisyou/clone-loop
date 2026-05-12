---
description: "Manage the Clone API key used by Clone Loop"
argument-hint: "status|import-env|set <key>|clear"
allowed-tools: Bash(node *manage-api-key.mjs*)
hide-from-slash-command-tool: "true"
---

# Clone API Key Command

Use the Bash tool to execute the Node API key manager:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/manage-api-key.mjs" $ARGUMENTS
```

Supported subcommands:

- `status`: show the effective token source and masked token.
- `import-env`: save the current `CLONE_API_TOKEN` value into Claude plugin data.
- `set <key>`: save a key directly into Claude plugin data. Prefer `import-env` because direct command arguments may remain in the transcript.
- `clear`: remove the saved plugin config key.

Never print the full token. Report only the masked token and the active source:
`environment`, `plugin config`, or `demo fallback`.
