---
name: clone-interview
description: Clarify requirements into a Clone Interview spec in Codex.
---

# Clone Interview

Use this skill when the user asks to run `/clone:interview`, start a Clone Interview, clarify requirements, or turn a vague task into a spec.

Run the setup script with the user's topic and options:

```bash
node "${PLUGIN_ROOT}/scripts/setup-clone-interview.mjs" $ARGUMENTS
```

If setup succeeds, run the interview in this Codex session.

Interview rules:

- Inspect repository facts first for the topic, including stack, file structure, existing patterns, and relevant tests.
- Auto-confirm only exact repo facts, and write them into the spec as `[from-code][auto-confirmed]`.
- Ask the user for goals, audience, scope, non-goals, product tradeoffs, business logic, acceptance criteria, constraints, and verification.
- Ask one question at a time.
- For free-form answers that carry scope or constraints, structure the answer and confirm nothing was lost before recording it.
- In `quick` mode, close goal, output, and acceptance criteria.
- In `deep` mode, close goal, audience, constraints, outputs, acceptance criteria, non-goals, and verification.
- Before closing, restate the final one-sentence goal and get user confirmation, then update the spec markdown.

Supported options:

- `--max-questions <n>`: maximum interview questions before restating, default `12`.
- `--mode <quick|deep>`: interview depth, default `deep`.
- `--output <path>`: project-local markdown spec path, default `.claude/clone-interview.local.md`.

Clone Interview v1 is plugin-only. Do not call Clone MCP as an interview question generator unless a future Clone MCP interview tool is explicitly available.
