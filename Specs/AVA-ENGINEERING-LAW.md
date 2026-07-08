# AVA Engineering Law

*To every future engineer and every future AI agent working in this repo: read this
before you write a single line that touches an LLM. This is not a guideline. It is law.*

Architectures like this one do not fail because they are wrong. They fail when, six
months in, someone ships `const answer = await openai.chat(...)` because it was faster.
Do that enough times and the Governor is irrelevant, the ODL is bypassed, telemetry
fragments, and costs become unpredictable. This document exists to make that impossible.

---

## THE SACRED RULE

> **No feature may call an LLM directly. Every AI invocation goes through**
> **ODL → Governor → Capability Registry → `avaReason()`. No exceptions — not for**
> **prototypes, not for "just this once."**

If you think you have a reason to bypass this, you are wrong. Add a capability instead.

---

## Enforcement (this is not honor-system)

1. **`avaReason()` holds the credentials — nothing else does.** It is the ONLY code
   path that sees `OPENROUTER_API_KEY` or `env.AI`. Feature code never touches model
   credentials or provider SDKs directly. There is one helper per package:
   `worker/src/lib/ava_reason.ts` and `consumers/src/ava_reason.ts`.

2. **The grep gate: `scripts/check_ava_reason.sh`.** It scans `worker/src` and
   `consumers/src` for direct model-call markers (`openrouter.ai`, `env.AI.run(`,
   `.AI.run(`, `api.openai.com`, `generativelanguage.googleapis.com`,
   `api.deepseek.com`) and fails if any appear outside the `ava_reason` modules and
   outside `scripts/ava_reason_allowlist.txt`. That allowlist is a **ratchet**: it was
   seeded with the pre-migration call sites. **Removing a line** (a site migrated to
   `avaReason()`) needs no review. **Adding a line** is a review event and must be
   signed off by the capability owner. Run it before you push AI code.

3. **Untagged reasoner calls throw.** Every `avaReason()` call MUST carry
   `{ role, capability, trigger }` (and `opportunity` where scored). Missing tags
   **throw in dev** and are dropped + alerted in prod — never break a user flow, but
   never let an untagged call through silently either.

4. **Every capability has a named owner** in the Capability Registry and ledger. No
   owner, no capability. If you build it, your name is on it.

---

## Capability Design Guidelines — the gate for every NEW capability

If a proposed capability cannot answer **all** of these, it does not get built:

- [ ] **What event wakes it?** (the ODL trigger)
- [ ] **Opportunity threshold?** (the score above which it may act)
- [ ] **Expected user value?**
- [ ] **Monthly cost budget?**
- [ ] **SLA?**
- [ ] **Kill switch name?**
- [ ] **PostHog metrics?**
- [ ] **Learning signals?**
- [ ] **UserBrain reads/writes — which scopes?**
- [ ] **Lifecycle entry point** — must start as `shadow`.
- [ ] **Owner?**

### The four escalation questions — answer in order, stop when one suffices

Before a capability is allowed to call the Reasoner at all, justify why nothing cheaper
works, in this exact order:

1. **Why can't regex do this?**
2. **Why can't embeddings do this?**
3. **Why can't a small model do this?**
4. **Why does it need the Reasoner?**

Most "AI features" die at question 1 or 2 — that is the point. The Reasoner is the
last resort, not the first reach.

---

## The funnel this protects (the whole point of the plan)

```
1,000,000 messages → ~50k ODL wake candidates → ~8k opportunities → ~1k reasoner calls
```

Message volume and AI cost stay decoupled **only as long as nothing bypasses the pipe.**
Every direct LLM call punches a hole in that funnel. Do not punch holes.
