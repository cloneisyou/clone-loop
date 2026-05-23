---
name: clone-api-key
description: Manage the Clone API key used by Clone Loop.
---

# Clone API Key

Use this skill when the user asks to check, import, set, or clear the Clone API key.

Run:

```bash
node "${PLUGIN_ROOT}/scripts/manage-api-key.mjs" $ARGUMENTS
```

Supported subcommands:

- `status`
- `import-env`
- `import-env --connect`
- `set <key>`
- `set <key> --connect`
- `connect`
- `clear`

Never print the full token. Report only the masked token and active source: `environment`, `plugin config`, or `demo fallback`.
