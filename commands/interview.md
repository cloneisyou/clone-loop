---
description: "Clarify requirements into a Clone Interview spec"
argument-hint: "TOPIC [--max-questions N] [--mode quick|deep] [--output PATH]"
allowed-tools: Bash(node *setup-clone-interview.mjs*), AskUserQuestion
hide-from-slash-command-tool: "true"
---

# Clone Interview Command

Use the Bash tool to execute the Node setup script and initialize the Clone Interview:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-clone-interview.mjs" $ARGUMENTS
```

If setup succeeds, run the interview in this session.

First inspect repository facts that are directly relevant to the topic. Auto-confirm only exact facts from files, and mark them as `[from-code][auto-confirmed]` in the working spec.

Ask all human-judgment questions through AskUserQuestion so Clone Interview can predict the user's answer first. When the prediction clears the configured threshold, the hook will fill in the answer automatically. When confidence is low, AskUserQuestion will reach the user normally.

Ask one question at a time. For free-form answers that include scope or constraints, structure the answer and confirm nothing was lost before recording it. Before closing, restate the one-sentence goal and get user confirmation, then update the spec markdown.
