# Phase 5 — Tool Layer (Strata + Broker + MCP connect)

**Read `00-MASTER-PLAN.md` first. 🚫 No commit/push — leave the tree for Phase 11.**

## Depends on
P0 (`AvaTool` interface, ToolRegistry, route registered, PaidFeature for paid tools).

## OWNED FILES
- NEW dir `app/lib/core/ava_tools/` — `tool_registry_impl.dart`, core tools
  (`translate`, `schedule`, `send_to`, `image_generate` shim → P9, `brain_search`
  shim → P4), and the Strata client.
- NEW dir `app/lib/features/ava_tools/` — MCP **connect UI** (per-user OAuth via
  Strata `handle_auth_failure`), free-bundled vs subscription gating with PaidFeature.
- NEW: `worker/src/routes/ava_tools.ts` — proxy to self-hosted Strata; per-user
  OAuth token storage (encrypted, scoped); free/sub enforcement before `execute_action`.
- NEW: `app/lib/features/settings/sections/tools_section.dart` (registered).

## DO NOT TOUCH
P0 hot files. Don't implement image gen here (call P9's tool); don't implement
brain.search here (call P4's).

## Tasks
1. Stand up **self-hosted Strata** access from the worker; expose discover →
   get_category_actions → get_action_details → execute_action through `ava_tools.ts`.
2. Tool broker: only ever surface the small core set + dynamic discovery (no full
   catalog in context). Enforce free-bundled vs subscription per connector.
3. MCP connect UI: user connects their own Gmail/Drive/etc.; tokens user-scoped.

## Acceptance
- Ava can discover + execute a connected MCP action (e.g., send an email).
- Tool overload avoided (≤ small core + on-demand discovery).
- Only OWNED FILES changed. No git ops. Note appended to INTEGRATION-NOTES.md.
