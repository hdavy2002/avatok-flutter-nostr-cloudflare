# Infrastructure Platform — Canonical Architecture

**Status: FROZEN 2026-07-05 (owner decision) — boundaries frozen; body deepens via
amendments/appendices against `AVAVERSE-CLOUDFLARE-NATIVE-ARCH.md` and the
resource/secrets specs.** Governed by `ENGINEERING-CONSTITUTION.md`; the
universal laws are not restated here. This platform owns *where and how everything
runs*. It is the concrete home of the storage providers that sit behind the State
Platform's storage abstraction. Evolves only by amendment, appendix, deprecation
notice, or ADR.

---

## Purpose

Where does everything run? Provide the runtime, storage backends, observability,
delivery pipeline, and operational guarantees the other four platforms depend on.

## Scope

Cloudflare (Workers, Durable Objects, Queues, D1, R2, KV), storage providers,
observability and telemetry transport, deployment/CI-CD, cost, security, and
operations.

## Owns

- **Runtime** — Workers, Durable Objects (including per-user Inbox/Session DOs and
  DO-local SQLite), Queues.
- **Storage providers** — the concrete backends behind the State Platform's storage
  abstraction: R2, Google Drive, iCloud, OneDrive, NAS, and future providers.
- **Datastores** — D1, KV, and their operational limits.
- **Observability & telemetry transport** — PostHog ingestion, dashboards,
  annotations, logs (the *pipe* for every platform's telemetry contract).
- **Deployment / CI-CD** — GitHub Actions build workflows (manual-dispatch only),
  Wrangler deploys, environment/secret management.
- **Cost** — the cost-per-scale model and budgets.
- **Security** — secrets management, edge security, network posture.
- **Operations** — runbooks, incident response, monitoring.

## Never Owns

- **What state means or how it's modeled** → **State Platform.** Infrastructure
  provides bytes and compute; it never defines operations, streams, or durability
  semantics.
- **How information routes** → **Messaging Platform.**
- **Whether an entity is trusted** → **Trust Platform.**
- **What the platform thinks** → **Intelligence Platform.**
- **The telemetry *contract*** (which events must exist) → each owning platform;
  Infrastructure owns only the *transport* of those events.

---

## 1. Runtime

Cloudflare-native and server-authoritative. Per-user `InboxDO` (hibernatable
WebSocket + DO-local SQLite) is the messaging/state runtime primitive; the server is
the router and canonical owner while the device stays local-first. Group conferences
(≤25, LiveKit) and 1:1 P2P calls (CallRoom DO, 2-peer cap) run here. No Nostr, no
relay Worker.

## 2. Storage providers (behind the State abstraction)

The State Platform depends only on its storage *abstraction* (State Part X); this
platform supplies the implementations — R2 (shared/encrypted media), user Google
Drive (own-files, hybrid), and future iCloud/OneDrive/NAS. Adding or swapping a
provider is an implementation change here and never touches State's architecture.
Content-addressing and encryption-at-rest specifics live here.

## 3. Datastores & their limits

D1, KV, R2, and DO-local SQLite, each with documented operational limits (e.g.,
messages live in DO-local SQLite per user, not a single central high-write D1). KV
platform-config flags must be patched whenever code defaults change (readers do not
fall back to code defaults).

## 4. Observability & telemetry transport

PostHog (EU, project-scoped) is the transport for every platform's telemetry
contract, plus dashboards and deploy annotations. Each platform *defines* its events;
this platform *carries* them. Test-user telemetry must always carry the user's email
(and phone if available) for retrieval.

## 5. Deployment / CI-CD

**Builds are manual-only (permanent owner decision).** Every build workflow runs on
`workflow_dispatch` only; a push triggers no build. Deploys via Wrangler with the
shell token. Commits go through the mandated serialized `git_safe_commit.py` wrapper
with explicit paths, one issue per commit.

## 6. Cost, security & operations

The cost-per-scale model, secrets as the recoverable source of truth (Worker/Pages
secrets are write-only), edge security posture (e.g., Cloudflare 400/0-RTT behavior),
per-account isolation at the platform edge, and operational runbooks.

## 7. Telemetry contract

At minimum: `deploy_started` / `deploy_completed`, `worker_error`, `queue_depth`,
`do_hibernated` / `do_woke`, `storage_provider_call` / `storage_provider_error`,
`cost_sample`, `build_dispatched`. Infrastructure health is observable.

## 8. Evolution rules

Provider, region, and runtime choices live here precisely so the four platforms above
never have to change when infrastructure does. Changes are amendments, appendices,
deprecation notices, or ADRs — never a new foundational spec.
