# AvaApps — Security Notes (documentation only)            Date: 2026-07-02

Recorded during the AvaApps pipeline fix (Phase 4). These are **recommendations, not code changes** — the affected code is legacy and shared by other features, so touching it is out of scope for this fix. Filed so the risks are tracked and owned.

## #11 — Asymmetric token-at-rest in legacy direct-Google paths

**Observation.** In the older direct-Google libraries (`worker/src/lib/gmail.ts`, `worker/src/lib/drive.ts`, `worker/src/cal/gcal.ts`), Composio/Google **access tokens transit and rest in plaintext in D1**, while **refresh tokens are AES-GCM encrypted** — an inconsistent posture. Access tokens are short-lived, but a D1 read (backup, log, or SQL injection) would expose live tokens.

**Recommendation.**
- Prefer the **Composio-managed** path (which is what current AvaApps uses) — Composio holds the OAuth material, and our Worker never persists Google tokens. New features should NOT reintroduce direct-token storage.
- For the remaining legacy callers, encrypt access tokens at rest with the same AES-GCM key already used for refresh tokens (symmetry), or drop them to a short-TTL KV/DO instead of D1.
- Audit which features still call the legacy libs and plan their retirement (see #13).

## #13 — Two OAuth surfaces to audit

**Observation.** The Composio-managed OAuth (current AvaApps) coexists with the legacy direct-Google OAuth in `lib/gmail.ts` / `lib/drive.ts` / `cal/gcal.ts`. Two consent surfaces = two attack surfaces, two token stores, two revocation stories.

**Recommendation.**
- Converge on **one** OAuth surface. Composio-managed is the strategic choice (no token custody for us). Inventory the legacy callers (e.g., Drive backup, Calendar sync) and migrate them onto Composio or an internal single surface, then delete the legacy libs.
- Until then, document which scopes each surface requests so a security review can reason about total granted access per user.

## #1 — Composio-level token-refresh race

**Observation.** Two concurrent AvaApps requests for the same user can each trigger a Google token refresh at the Composio-account level; occasionally one receives a briefly-stale token. Composio manages refresh, so this is mostly mitigated, but our side does nothing to serialize.

**Recommendation.**
- If stale-token errors show up in telemetry (`avaapps_run_error stage:"tool_exec"` with an auth-ish `detail`, or `avaapps_composio_retry` clusters), add a per-user short-lived lock (KV `avaapps:reflock:<uid>` with a few-second TTL, or a per-user Durable Object) to serialize the first tool call of concurrent runs.
- Do NOT build this pre-emptively — it adds latency to the common (single-request) case. Gate the decision on the post-deploy dashboard.

---

*Cross-refs: `Specs/AVAAPPS-PIPELINE-REVIEW-2026-07-02.md` §4 (#1, #11, #13); Phase 4 report `Specs/reports/avaapps-fix/PHASE-4-REPORT.md`.*
