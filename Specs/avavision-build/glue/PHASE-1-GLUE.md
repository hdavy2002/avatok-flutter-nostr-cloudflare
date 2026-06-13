# PHASE 1 GLUE NOTE — AvaVision Worker backend

**Author:** Phase 1 (Worker backend). **Date:** 2026-06-13. **Commit:** none (per master rule 2 — Phase Z commits).

## Files created (owned by Phase 1)
- `worker/src/routes/avavision.ts` — full route module (mirrors `avavoice.ts`).
- `worker/migrations/avavision.sql` — D1 schema (`avavision_agents`, `avavision_agent_files`,
  `avavision_bookings`, `avavision_sessions`, `avavision_snapshots`).
- `Specs/avavision-build/glue/PHASE-1-GLUE.md` — this note.

`Specs/avavision-templates.json` already existed — NOT overwritten. The catalog is also inlined as a
typed `TEMPLATE_CATALOG` constant in `avavision.ts` (master §6 allows in-file constants for static
catalogs, like AvaVoice's `VOICES`). Keep the two in sync; the JSON file stays canonical.

## Isolated build result
- `cd worker && npx tsc --noEmit` → **0 errors** (fully clean).
- Note: the kill-switch is read as `(cfg as any).avavisionEnabled` (mirroring how `avavoice.ts` reads
  `(cfg as any).avavoiceEnabled`), so there is **no** `config.avavisionEnabled` type error even before
  Phase Z adds the flag. The flag is still required at runtime to actually gate the routes (below).

---

## SHARED FILE CHANGES FOR PHASE Z (copy-paste)

### 1. `worker/src/index.ts`

**Import block** (add near the avavoice import, ~line 39–43):
```ts
import {
  avavisionTemplates, avavisionVoices, avavisionMarketplace, avavisionMine, avavisionCreateAgent,
  avavisionGetAgent, avavisionUpdateAgent, avavisionPublish, avavisionDeleteAgent, avavisionUploadFile,
  avavisionDeleteFile, avavisionAvailability, avavisionStats, avavisionBook, avavisionMyBookings,
  avavisionCancelBooking, avavisionCallNow, avavisionSessionStart, avavisionHeartbeat,
  avavisionSessionStop, avavisionSnapshot,
} from "./routes/avavision";
```

**Dispatch block** (add right after the avavoice block, ~line 392). Mirrors the avavoice block plus
`/templates` and `/snapshot`:
```ts
      // --- AvaVision: creator-built AI VISION coaching agents (Specs/AVAVISION-PROPOSAL.md) ---
      if (p === "/api/avavision/templates" && req.method === "GET") return avavisionTemplates(req, env);
      if (p === "/api/avavision/voices" && req.method === "GET") return avavisionVoices();
      if (p === "/api/avavision/marketplace" && req.method === "GET") return await avavisionMarketplace(req, env);
      if (p === "/api/avavision/agents/mine" && req.method === "GET") return await avavisionMine(req, env);
      if (p === "/api/avavision/agents" && req.method === "POST") return await avavisionCreateAgent(req, env);
      if (p === "/api/avavision/bookings" && req.method === "POST") return await avavisionBook(req, env);
      if (p === "/api/avavision/bookings/mine" && req.method === "GET") return await avavisionMyBookings(req, env);
      if (p === "/api/avavision/calls/now" && req.method === "POST") return await avavisionCallNow(req, env);
      if (p === "/api/avavision/sessions/start" && req.method === "POST") return await avavisionSessionStart(req, env);
      if (p === "/api/avavision/sessions/heartbeat" && req.method === "POST") return await avavisionHeartbeat(req, env);
      if (p === "/api/avavision/sessions/stop" && req.method === "POST") return await avavisionSessionStop(req, env);
      if (p === "/api/avavision/snapshot" && req.method === "POST") return await avavisionSnapshot(req, env);
      {
        const bk = p.match(/^\/api\/avavision\/bookings\/([A-Za-z0-9-]{1,64})\/cancel$/);
        if (bk && req.method === "POST") return await avavisionCancelBooking(req, env, bk[1]);
        const af = p.match(/^\/api\/avavision\/agents\/([A-Za-z0-9-]{1,64})\/files\/([A-Za-z0-9-]{1,64})$/);
        if (af && req.method === "DELETE") return await avavisionDeleteFile(req, env, af[1], af[2]);
        const aa = p.match(/^\/api\/avavision\/agents\/([A-Za-z0-9-]{1,64})\/(publish|unpublish|files|availability|stats)$/);
        if (aa) {
          if (aa[2] === "publish" && req.method === "POST") return await avavisionPublish(req, env, aa[1], true);
          if (aa[2] === "unpublish" && req.method === "POST") return await avavisionPublish(req, env, aa[1], false);
          if (aa[2] === "files" && req.method === "POST") return await avavisionUploadFile(req, env, aa[1]);
          if (aa[2] === "availability" && req.method === "GET") return await avavisionAvailability(req, env, aa[1]);
          if (aa[2] === "stats" && req.method === "GET") return await avavisionStats(req, env, aa[1]);
        }
        const ag = p.match(/^\/api\/avavision\/agents\/([A-Za-z0-9-]{1,64})$/);
        if (ag) {
          if (req.method === "GET") return await avavisionGetAgent(req, env, ag[1]);
          if (req.method === "PUT") return await avavisionUpdateAgent(req, env, ag[1]);
          if (req.method === "DELETE") return await avavisionDeleteAgent(req, env, ag[1]);
        }
      }
```

### 2. `worker/src/routes/config.ts`
Add to the `ConfigShape` interface (near `avavoiceEnabled`, ~line 28):
```ts
  avavisionEnabled: boolean;         // master switch for /api/avavision/*
```
Add to the defaults object (near `avavoiceEnabled: true`, ~line 50):
```ts
  avavisionEnabled: true,
```
(Runtime: `avavision.ts`'s `flagOff()` reads `(cfg as any).avavisionEnabled`; until this default exists
it reads `undefined` and treats the app as **enabled**. Adding the flag lets admins kill-switch it.)

### 3. `worker/wrangler.toml`
- **No new DO / migration tag needed.** The `[[migrations]]` blocks in wrangler.toml are **Durable
  Object** class migrations only; D1 schema is applied out-of-band via the REST recipe (see §4). Phase 1
  added NO Durable Object (slot cap = D1 active-session count; snapshot cap = D1 `snapshot_calls`).
- Add the snapshot model var to **both** `[vars]` (prod, ~line 21) and `[env.staging.vars]`:
```toml
AVAVISION_SNAPSHOT_MODEL = "gemini-3-flash"   # PRICING-TBD: verify exact string vs live key (Phase 0 spike)
```
- Optional (only if you want a non-default Live model): `AVAVISION_VISION_MODEL = "gemini-3.1-flash-live-preview"`.
  Not required — the code defaults to that string.

### 4. D1 apply (Phase Z)
Run `worker/migrations/avavision.sql` against **`avatok-meta`** on **prod and staging** via the project's
REST migration recipe (same path used for other meta migrations; see memory `staging-env-gaps-2026-06-11`
and `wrangler-deploy-sandbox-limit`). All tables/indexes are `IF NOT EXISTS`, so re-running is safe.

### 5. Optional type-cleanliness widenings (NOT required — runtime already works via casts)
Two shared type unions don't yet know about AvaVision. Phase 1 used `as any` casts so the isolated build
is clean. Phase Z may widen them for tidiness:
- `worker/src/routes/insights.ts` — `recordView` `kind` union: add `"vision_agent"`.
- `worker/src/routes/affiliate.ts` — `settleAffiliate` `app` union: add `"avavision"`.

---

## PRICING-TBD placeholders (Phase 0's `PRICING.md` was NOT present — reconcile when it lands)
- `MIN_RATE_PER_HOUR = 100` (coins, $1/h) — copied from AvaVoice's floor (master: "likely ≥ 100").
- `DEFAULT_FREE_SNAPSHOTS = 3` — used only when a template enables snapshots but omits a per-session cap.
- `DEFAULT_SNAPSHOT_MODEL = "gemini-3-flash"` — exact string unverified against the live key; the snapshot
  spike must confirm and set `AVAVISION_SNAPSHOT_MODEL` accordingly.
- Reused unchanged from AvaVoice (owner-locked, not TBD): `CREATOR_PAYS_RATE_PER_HOUR=500` ($5/h),
  `FEE_RATE=0.5`, `MAX_SESSION_MIN=60`, `MAX_CONCURRENT=10`, `SESSION_LIMITS={5,10,30,60}`.

## Contract notes for downstream phases (2–5 build against these)
- **Wire convention is snake_case** (authoritative, per PHASE-1 §A). All responses use `session_id`,
  `token_expires_at`, `beat_every_sec`, etc. The `VisionAgent` object, `sessions/start`, `snapshot`,
  `marketplace` (with `availability`), and `templates` responses match PHASE-1 §A exactly.
- **Idempotency** (§B) implemented: order namespace `avvis_<uuid>` (never `avv_`); `release` settlementId
  `avvis:<session_id>`; refunds `refund:<order_id>:cancel|unused`; `sessions/stop` short-circuits when
  `status != 'active'` and returns the already-settled payload; `snapshot` increments `snapshot_calls`
  only after a successful model call.
- **Snapshot cost is bundled** into the session (owner decision Q-AV1) — no separate fee; bounded by
  `free_snapshots_per_session`, enforced via the D1 counter.
- **Vision config seeding:** create/update accept the full vision field set; when omitted they default
  from the chosen `template_id`. `agentic_snapshot_enabled` is derived from `vision_mode ∈ {both, snapshot}`.
  Publish enforces capability∈enum, iOS-engine policy (`face_landmark|segmentation|holistic ⇒ ios:false`),
  overlay/scoring coherence, `rate ≥ MIN_RATE_PER_HOUR`, template safety_notes preserved, and 1–5 photos.
- **Token video lock:** `mintToken` sets `generationConfig.mediaResolution = "MEDIA_RESOLUTION_LOW"`;
  `frames_per_sec: 1` is advertised to the client in `sessions/start`. The Live model defaults to
  `gemini-3.1-flash-live-preview`.

## Drift from master
- None material. The one judgment call: the templates catalog is inlined as a TS constant (master §6
  explicitly permits this) in addition to the canonical JSON file, so the `/templates` endpoint has no
  bundler/asset dependency.
