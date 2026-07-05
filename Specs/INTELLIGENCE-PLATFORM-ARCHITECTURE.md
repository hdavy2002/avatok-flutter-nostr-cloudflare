# Intelligence Platform — Canonical Architecture

**Status: FROZEN 2026-07-05 (owner decision) — boundaries frozen; body deepens via
amendments/appendices against AvaApps/Composio, AvaBrain, and agent specs.**
Governed by `ENGINEERING-CONSTITUTION.md`; the universal laws are not restated here. Named **Intelligence**, not "AI" — a boundary that outlives whichever
technology powers it (constitution §5). This platform owns how AvaTOK *thinks*.
Evolves only by amendment, appendix, deprecation notice, or ADR.

---

## Purpose

How does the platform think? Turn knowledge, memory, and tools into reasoning,
planning, and automation on the user's behalf.

## Scope

Knowledge, memory, agents, reasoning, planning, automation, tool execution, context,
and the agent/tool marketplace.

## Owns

- **Knowledge** — ingested, indexed information the platform can reason over.
- **Memory** — durable, retrievable context across sessions (as *cognition*, distinct
  from raw state).
- **Agents** — autonomous actors that plan and act toward goals.
- **Reasoning & planning** — turning context + goals into steps.
- **Automation** — triggered and scheduled action.
- **Tool execution** — invoking external capabilities (the AvaApps / Composio tool
  loop; Gmail, Outlook, Drive, Calendar, etc.) under permission.
- **Context** — assembling the right inputs for a given reasoning task.
- **Marketplace** — discovery and composition of agents and tools.

## Never Owns

- **The truths it reasons over** → **State Platform.** Knowledge and memory are
  *projections and streams* owned by State; Intelligence owns the *cognition*, not the
  persistence.
- **Whether an agent or tool is permitted to act** → **Trust Platform.** Every agent
  action is gated by a Trust permission.
- **How results are delivered to a user** → **Messaging Platform.**
- **The runtime / model hosting / secrets** → **Infrastructure Platform.**

---

## 1. Core stance

Intelligence is a *consumer* of the other platforms, never a fork of them. It reads
state (via State Platform projections), acts through tools (gated by Trust), and
communicates results (via Messaging). AvaBrain-style ingestion is **consent-gated**:
on by default with a master switch and per-app guardrails, and private/E2E content is
read on-device only regardless of toggle.

## 2. Knowledge & memory

Knowledge is ingested and indexed for retrieval; memory is durable cross-session
context. Both are materialized from operations owned by the State Platform —
Intelligence defines *what to remember and how to recall it*, not *how it survives*.
Per-account scoping is mandatory: one account's knowledge/memory never leaks to
another on a shared device.

## 3. Agents, reasoning & planning

Agents plan and act toward goals using context, knowledge, and tools. Reasoning and
planning are the platform's cognitive core. Every autonomous action an agent takes is
attributable (an operation, via State) and permissioned (via Trust).

## 4. Automation

Triggered and scheduled behavior — @-mentioned in-chat tool loops, recurring digests,
event-driven actions. Automation composes agents and tools; it does not embed private
copies of either.

## 5. Tool execution (AvaApps / Composio)

The external-capability layer runs on Composio (Worker secret; Gmail + Outlook live,
Drive/Calendar/Docs staged). Tools are invoked through one uniform loop, each call
permission-checked against Trust and recorded as an operation in State.

## 6. Marketplace

Discovery and composition of agents and tools — the agent-to-agent and tool ecosystem.
Listings and negotiation are State-backed and Trust-gated like any other marketplace.

## 7. Telemetry contract

At minimum: `agent_run_started` / `agent_run_completed`, `tool_invoked` /
`tool_failed`, `reasoning_step`, `memory_written` / `memory_recalled`,
`knowledge_ingested`, `automation_triggered`, `permission_denied`. Cognition is
observable.

## 8. Evolution rules

Model choice, provider, and technology are deliberately *below* this boundary — "AI"
today, something else tomorrow, without reopening the platform. Changes are
amendments, appendices, deprecation notices, or ADRs — never a new foundational spec.
