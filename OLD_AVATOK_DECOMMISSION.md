# Old avatok.ai — Decommission Memory

> Running list of everything tied to the **old** avatok.ai app/codebase. The domain
> `avatok.ai` STAYS (new app uses it too). What gets decommissioned is the old app's
> infrastructure — workers, buckets, KV, old code — NOT the domain and NOT the Clerk
> tenant (the new app REUSES the existing avatok.ai Clerk tenant, per user decision).
> When the new stack is live and verified, work through this list to tear down the
> old infra.
>
> **Status legend:** 🔴 confirmed old-avatok infra · 🟡 needs confirmation (ambiguous name / shared account) · ⚪ referenced in spec only · ♻️ REUSED by new app (do NOT decommission)
>
> Last updated: 2026-06-03

---

## 1. Cloudflare (account currently active in MCP)

> **Account (DECIDED):** use the CURRENT Cloudflare account (user: `hdavy2005@gmail.com`).
> The connected account already contains the avatok workers/KV below, which confirms
> it IS the avatok account — the new app lives here too. The CF MCP doesn't expose
> account enumeration (`accounts_list` not available), so if a SECOND CF account
> exists under another login, it must be checked from the dashboard manually.

### Workers
| Worker | Created | Status | Notes |
|---|---|---|---|
| `avatok-comms-bridge` | 2026-05-28 | 🔴 | Name explicitly avatok. Likely push/notification or call-signaling bridge. |
| `avatok-video-proxy` | 2025-12-10 | 🔴 | Name explicitly avatok. Old video delivery proxy. |
| `upload-api-production` | 2025-12-29 | 🟡 | Matches old avatok upload pipeline (§4 media). Confirm owner. |
| `moderation-callback-production` | 2025-12-29 | 🟡 | Matches old avatok moderation pipeline (§8). Confirm. |
| `content-ingestion-video-processor` | 2025-11-02 | 🟡 | Matches old avatok video ingestion. Confirm. |
| `cleanup-cron` / `cleanup-cron-production` | 2025-12-29 | 🟡 | Cron cleanup — confirm whether avatok. |
| `pipeline-orchestrator` | 2025-12-29 | 🟡 | Confirm whether avatok. |
| `unitedcockroachesofindia` | 2026-05-21 | 🟡 | Unknown; India-related name. Confirm. |
| `jonji-api`, `jonji-api-production` | 2026-04 | ⚪ | Appears to be a DIFFERENT project (jonji). Leave alone unless told otherwise. |
| `humphi-knowledge` | 2026-03-25 | ⚪ | DIFFERENT project (humphi). Leave alone. |

### KV namespaces
| Namespace | ID | Status | Notes |
|---|---|---|---|
| `avatok-comms-tokens` | d5469307e5aa45ef9d1278906a561eaa | 🔴 | Old push-token registry for avatok comms bridge. |
| `jonji-cache` | d33b3bfa51514e3b9cac2ca796cb60cb | ⚪ | Different project. |

### D1 databases
| DB | Status | Notes |
|---|---|---|
| `jonji-users` | ⚪ | Different project. |
| `humphi-knowledge` | ⚪ | Different project. |
| _(no avatok-named D1 currently visible)_ | 🟡 | Old avatok D1 may have been deleted, renamed, or live in another CF account. Verify. |

### R2 buckets
| Bucket | Status | Notes |
|---|---|---|
| `immernah-*`, `jonji-media` | ⚪ | Different projects. |
| _(no `avatalk-blobs` / `avatok-*` bucket visible)_ | 🟡 | Old avatok blob/verification buckets not in this account, or already gone. Verify. |

### Still to inventory on Cloudflare
- DNS records / custom hostnames on avatok.ai (video.*, relay.*, blossom.*).
- Stream / Stream Live resources.
- Workers AI bindings, Queues, Durable Object namespaces.
- Pages projects.
- Whether old avatok lives in a SEPARATE Cloudflare account than the one above.

---

## 2. Clerk (identity)
- ♻️ **DECIDED: REUSE the existing avatok.ai Clerk tenant.** Do NOT create a new one
  and do NOT decommission it. New app authenticates against the same tenant.
  No Clerk management MCP is connected (only a code-snippet helper), so I'll need a
  Clerk **API key / dashboard access** to wire the new Workers to it.

## 3. Domains
- ♻️ `avatok.ai` — the ONE domain. Stays. The NEW app uses it too. New subdomains
  hang off it: `relay.avatok.ai`, `video.avatok.ai`, `blossom.avatok.ai`,
  `app.avatok.ai`, NIP-05 handles `user@avatok.ai`. (Spec corrected: it previously
  said `abertalk.ai` — that was wrong; replaced everywhere with `avatok.ai`.)
- Old DNS records / hostnames pointing at OLD workers/buckets are decommission
  candidates once new infra is live.

## 4. Other vendors (verify for old-avatok footprint)
- Bunny.net — old Stream library/pull zone for avatok video. No MCP connected.
- Stripe — account `acct_1TPECFA05rLa7En1` "FynextLabs sandbox" (sandbox, not prod).
- PostHog — check for an old avatok project; new app should use a fresh project keyed by npub.
- Novu — US region key loaded; check for old avatok workflows.
- Supabase / Vercel — spec REMOVED both from the stack. If old avatok used them, they are decommission candidates too.

---

## Decommission order (later, after new stack verified)
1. Confirm which CF account(s) hold old avatok resources.
2. Snapshot/export any data worth keeping.
3. Tear down old Workers → KV → D1 → R2 → DNS → Bunny → Clerk tenant (if not reused).
4. Keep `avatok.ai` domain live (parking/redirect) per user instruction.
