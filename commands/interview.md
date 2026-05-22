---
description: "Clarify a goal into a Clone Interview plan"
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

Drive the interview toward an executable plan, not just a list of answers. Keep the spec's Goal Contract, Decision Ledger, Plan Draft, Readiness Audit, and Execution Handoff current after every answer.

Ask one question at a time using this frame:

```md
Current understanding: ...
Blocked decision: ...
Clone predicted answer: ... or escalated
Question: ...
Plan impact: ...
```

Question priority is goal, outcome, scope/non-goals, decision boundaries, constraints, acceptance criteria, then plan risks. Record decisions as `[from-user]`, high-confidence Clone answers as `[from-clone][auto]`, and low-confidence suggestions as `[from-clone][escalated]` before asking the user.

Before closing, run the Readiness Audit. If anything fails, ask the single question that most improves the Plan Draft. When the audit passes, ask the user to choose: Refine plan, Start Clone Loop with this plan, Implement manually from this plan, or Stop here.
