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
- Keep the Goal Contract, Decision Ledger, Plan Draft, Readiness Audit, and Execution Handoff current after every answer.
- Ask one question at a time using this exact frame: `Current understanding`, `Blocked decision`, `Clone predicted answer` or `escalated`, `Question`, and `Plan impact`.
- Prioritize questions in this order: goal, outcome, scope/non-goals, decision boundaries, constraints, acceptance criteria, plan risks.
- For free-form answers that carry scope or constraints, structure the answer and confirm nothing was lost before recording it.
- In `quick` mode, close goal, outcome, scope, acceptance criteria, and a minimal Plan Draft.
- In `deep` mode, close goal, audience, decision boundaries, constraints, non-goals, acceptance criteria, risks, and Execution Handoff.
- Before closing, run the Readiness Audit. If any item fails, ask the single question that most improves the Plan Draft.
- When the Readiness Audit passes, ask the user to choose one handoff path: Refine plan, Start Clone Loop with this plan, Implement manually from this plan, or Stop here.

Supported options:

- `--max-questions <n>`: maximum interview questions before restating, default `12`.
- `--mode <quick|deep>`: interview depth, default `deep`.
- `--output <path>`: project-local markdown spec path, default `.claude/clone-interview.local.md`.
- `--clone-threshold <n>`: confidence threshold for Clone auto-answers, default `0.75`.
- `--no-auto-answer`: disable Clone-predicted answers and always ask the user.

Clone Interview v1 is plugin-only for question generation. The agent generates interview questions; Clone MCP predicts how the user would answer and gates auto-answering by confidence. The goal is a plan-ready spec: do not keep asking after the Readiness Audit passes, and do not start implementation without an explicit handoff choice.
