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
- Before asking the user for goals, audience, scope, non-goals, product tradeoffs, business logic, acceptance criteria, constraints, or verification, run `scripts/predict-interview-answer.mjs` with the question.
- If the script returns `decision: "auto"`, record the predicted answer in the spec and keep interviewing.
- If the script returns `decision: "escalate"`, ask the user directly and record the user's answer.
- Ask one question at a time.
- For free-form answers that carry scope or constraints, structure the answer and confirm nothing was lost before recording it.
- In `quick` mode, close goal, output, and acceptance criteria.
- In `deep` mode, close goal, audience, constraints, outputs, acceptance criteria, non-goals, and verification.
- Before closing, restate the final one-sentence goal and get user confirmation, then update the spec markdown.

Supported options:

- `--max-questions <n>`: maximum interview questions before restating, default `12`.
- `--mode <quick|deep>`: interview depth, default `deep`.
- `--output <path>`: project-local markdown spec path, default `.claude/clone-interview.local.md`.
- `--clone-threshold <n>`: confidence threshold for Clone auto-answers, default `0.75`.
- `--no-auto-answer`: disable Clone-predicted answers and always ask the user.

Clone Interview v1 is plugin-only for question generation. The agent generates interview questions; Clone MCP predicts how the user would answer and gates auto-answering by confidence. Do not call Clone MCP as an interview question generator unless a future Clone MCP interview tool is explicitly available.
