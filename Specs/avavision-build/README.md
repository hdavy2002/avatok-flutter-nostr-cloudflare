# AvaVision build kit — how to run it

This folder turns `Specs/AVAVISION-PROPOSAL.md` + `Specs/avavision-templates.json` into a parallel,
multi-session build plan for a coding AI that knows nothing about the codebase.

## How to use it
Each build session gets **exactly two files as its context**: `MASTER-PROMPT.md` (always) + **one**
`PHASE-*.md`. Start one session per phase. Phases **0–6 run simultaneously** in separate sessions.
**Phase Z runs alone at the very end.**

```
Session 0:  MASTER-PROMPT.md  +  PHASE-0-SPIKE-AND-PRICING.md
Session 1:  MASTER-PROMPT.md  +  PHASE-1-WORKER-BACKEND.md
Session 2:  MASTER-PROMPT.md  +  PHASE-2-FLUTTER-STUDIO.md
Session 3:  MASTER-PROMPT.md  +  PHASE-3-FLUTTER-SESSION.md
Session 4:  MASTER-PROMPT.md  +  PHASE-4-WEB-STUDIO.md
Session 5:  MASTER-PROMPT.md  +  PHASE-5-WEB-SESSION.md
Session 6:  MASTER-PROMPT.md  +  PHASE-6-ADMIN-DASHBOARD.md
   (all of the above run in parallel; none of them commit)
Session Z:  MASTER-PROMPT.md  +  PHASE-Z-GLUE-AND-PUSH.md   (LAST, solo, the only one that commits)
```

**Phase 6 note:** the admin console ("AvaAdmin") is platform-wide, not AvaVision-specific — it ships in
this wave because AvaVision adds a new surface that needs monitoring. Its Worker endpoints have no hard
dependency on the other phases (live-ops cards degrade gracefully when a surface isn't deployed yet); its
web pages need the web-client Phase 0 foundation, same as Phases 4 & 5.

## The non-negotiables (enforced in every phase file)
- **No session commits or pushes except Phase Z.** Work is left uncommitted in the tree.
- **Each phase owns a disjoint set of files.** Shared files (`worker/src/index.ts`, `config.ts`,
  `wrangler.toml`, app registry/sidebar/create-listing, web scaffold/nav) are edited **only by Phase Z**,
  using the copy-pasteable instructions each phase leaves in `glue/PHASE-*-GLUE.md`.
- **Every phase ends by writing a Graphiti episode** (`group_id="proj_avaflutterapp"`) + its glue note,
  then stops. That's how Phase Z learns what happened.

## Why these phase boundaries (parallel-safe)
| Phase | Disjoint ownership |
|---|---|
| 0 | throwaway spike + `PRICING.md` (no product files) |
| 1 | `worker/src/routes/avavision.ts`, `worker/migrations/avavision.sql` |
| 2 | `app/lib/features/avavision/**` except `session/` + `app/lib/core/avavision_api.dart` |
| 3 | `app/lib/features/avavision/session/**` + Android native vision bridge |
| 4 | `web/src/pages/vision/` + `web/src/islands/vision/` studio + marketplace (inside the existing web client) |
| 5 | `web/src/.../vision/session/**` + the web vision engine (`visionEngineWeb.ts`) (inside the existing web client) |
| 6 | `worker/src/routes/admin_dashboard.ts` + `worker/scripts/seed-admin.ts` + `web/src/pages/admin/**` + `web/src/islands/admin/**` (admin console) |
| Z | all shared files, build, D1 migration, commit, push, deploy |

**Web ordering note:** Phases 4 & 5 build the AvaVision web surface **inside the public web client**
(`Specs/web-client/`), not a separate scaffold. They require the web-client **Phase 0 foundation**
(`web/` Astro scaffold + `zine` token kit + `apiClient` + Clerk `GuestGate`) to exist first, then run
in parallel with everything else. They mirror web-client **Phase E** (AvaVoice agent call) for the live
Gemini session and reuse the shared `GuestGate` + component kit. Phases 1, 2, 3 don't depend on the web.

## Key reality corrections baked in (from the codebase audit, override the proposal)
- **No Durable Object** — AvaVoice enforces the 10-slot cap via D1 active-session counting + a 2-min
  stale-heartbeat sweep; AvaVision mirrors that. Snapshot fair-use cap = a D1 counter. (Adding a DO
  would force a forbidden `wrangler.toml` migration mid-parallel-build.)
- **AvaVoice is fully built** and is the function-for-function template for the worker, app, and money.
- **The web client `web/` is built by the separate `Specs/web-client/` kit** — AvaVision Phases 4 & 5
  add the AvaVision feature *into* that web client (own only `web/src/pages|islands/vision/**`, reuse its
  foundation + `GuestGate` + kit, mirror its Phase E agent call). They don't scaffold `web/`.
- **iOS is a later, separate track** — not in this parallel wave (MoveNet already makes the templates
  iOS-ready where `platforms.ios=true`).
- **Admin console reuses existing infra** — the `requireAdmin` gate (`ADMIN_UIDS`), the `admin_audit`
  table, the existing `/api/admin/*` money endpoints, and the already-wired PostHog project (139917, EU)
  are reused; Phase 6 adds read-mostly aggregation + a PostHog query proxy on top. No new DO, no new
  money primitive. The seed admin is created in Clerk (password never committed); only its uid is added
  to `ADMIN_UIDS`.
