# AvaTok — Final Audit Report

**Date:** 2026-06-04
**Scope:** End-to-end review of the backend + Flutter app after the rebuild, the
credential/hardening pass, and the full scale-audit fix-all. Lens: correctness,
global speed, and cost at 10M users.

**Bottom line:** the stack is code-complete and internally consistent. Every
Worker passes `tsc --noEmit` and `wrangler deploy --dry-run`. All 12 scale-audit
findings are fixed. Nothing is deployed yet — deploys are deliberately held behind
`secrets/deploy.sh` pending 3 secret values + a coordinated APK ship. The earlier
"fast / cheap / scalable / secure" pitch is now largely **true in the code**, with
the honest caveats listed below.

---

## 1. What the system is

Four Cloudflare Workers on one account, one deploy script, sharing one identity
and one data plane:

| Worker | Role |
|---|---|
| `avatok-api` | Hardened `/api/*` control plane (NIP-98 + Clerk dual auth), media upload, ICE, Stream webhook, CallRoom DO. |
| `avatok-relay` | Nostr relay, now **per-user inbox Durable Objects** (hibernating), events → D1. |
| `avatok-consumers` | Queue consumers (moderation / push / email / analytics) + 6h cron. |
| `avatok-calls` | Pre-existing RealtimeKit/Stream token mint (untouched). |

Data: 4 D1 databases (global read replication via the Sessions API), R2 +
`blossom.avatok.ai` public edge cache, KV for ephemeral tokens, 4 Queues,
Workers AI for moderation, Analytics Engine for ops metrics, Vectorize provisioned.

---

## 2. Scale-audit fixes — all 12 done

| # | Issue | Fix | Bites without it |
|---|---|---|---|
| P0-1 | Single global relay DO | Per-user inbox DOs; local-deliver + DM/mention fan-out; no global broadcast | Global latency + hard throughput ceiling |
| P0-2 | D1 100-param limit | `chunk()` ≤90 in contacts match + relay filters | Crashes at >100 contacts / >100 follows |
| P1-3 | `search` full-table scan | FTS5 `profiles_fts` + prefix MATCH | ~10M rows_read per search |
| P1-4 | pHash O(n) blocklist scan | LSH band index | rows_read + CPU per upload; breaks past 5k |
| P1-5 | Vision-model AI cost | Cost metric + tier threshold + classifier swap path | Largest AI bill, unmonitored |
| P1-6 | Blossom edge cache | Verified live (30d, tiered) | Every media view = R2 read + origin hop |
| P1-7 | R2 re-fetch for pHash | Cache pHash in `moderation_results` | R2 GET + decode per re-upload |
| P2-8 | PostHog per-event POST | One `/batch` per queue batch | 50× HTTP overhead |
| P2-9 | Cross-request read-your-writes | Documented + responses return created objects | Rare stale read after write |
| P2-10 | Cron full scan | Partial index | Slower cron as media grows |
| P2-11 | Analytics Engine unused | Wired across all workers | No ops visibility |
| P2-12 | Relay shard trigger | Documented threshold | Surprise at ~5 GB relay DB |

New migrations (`meta_fts.sql`, `moderation_lsh.sql`, `moderation_phash_col.sql`,
`media_pending_index.sql`) are wired into `secrets/deploy.sh`.

---

## 3. The four pillars, re-assessed honestly

**Fast.**
- Media: served from Cloudflare's edge cache, bypassing the Worker — verified rule live. ✅
- Reads: D1 Sessions API routes reads to the nearest replica (Delhi/NY both local). ✅
- Real-time: per-user inbox DOs hibernate when idle and live where the user is; DMs deliver via targeted fan-out, no global broadcast. ✅
- "Sub-10ms API" remains an aspiration, not a measured SLA — depends on query + region.

**Cheap.**
- D1: hot paths indexed; reads on replicas (no egress charge); 25B rows-read/mo included **per account** (not per-DB). ✅ with correct expectation.
- AI moderation: free only to 10k neurons/day, then $0.011/1k — the vision model is the cost to watch; now metered, dedup'd by sha256, and one config flip from a ~100× cheaper classifier. ⚠️ monitored.
- Push free (FCM/APNs); media reads free at the edge; email on Brevo. ✅

**Scalable.**
- Relay shards across millions of tiny DOs; queues absorb async load; D1 relay time-shard is a documented config change. ✅
- No remaining O(all-connections) or O(all-rows) hot path. ✅

**Secure.**
- Dual auth: NIP-98 (key ownership) + Clerk session JWT (verified account), both required on mutations; reads open. ✅
- Public uploads AI-scanned before going live (fails open on AI error by design); DM media is client-encrypted ciphertext. ✅
- Perceptual blocklist catches resized/recompressed re-uploads (not crops); strike system escalates 24h → 7d → permanent ban. ✅

---

## 4. Cost posture at 10M users — the levers that matter

1. **Workers AI moderation** is the #1 variable cost. Mitigations in place: sha256
   dedupe (never rescan identical bytes), pHash cache (skip re-decode), per-scan
   neuron metric (Analytics Engine), and `MODERATION_MODEL_TYPE=classifier` to drop
   to a cheap NSFW model the moment one is enabled. **Watch the neuron dashboard.**
2. **D1 rows_read** is the #2 lever. FTS search, LSH band lookup, param chunking,
   and replica reads removed the full-scan/￼over-read paths. Keep an eye on relay
   feed queries as follow-counts grow.
3. **R2** stays cheap as long as the Blossom cache rule stays in place (verified) —
   content is sha256-immutable so hit-rate should be very high.
4. **Durable Objects** bill on active duration; per-user hibernation means most DOs
   cost ~nothing most of the time.

---

## 5. Verification done

- `tsc --noEmit` clean on `worker`, `relay`, `consumers`.
- `wrangler deploy --dry-run` bundles clean on all three (incl. Photon WASM).
- Live account checks: Stream enabled (71 live inputs), 4 Queues, D1 replication
  `auto` on all 4 DBs, Blossom cache rule + tiered cache on, Clerk JWKS reachable.
- Flutter: dependency + import + brace checks (no Flutter toolchain in the sandbox →
  CI builds the APK; `flutter analyze` is non-blocking in the workflow).

---

## 6. Remaining gates before launch (your side)

1. **Provide 3 secret values** in `secrets/secret-values.env`: `BREVO_API_KEY`,
   `TURN_KEY_API_TOKEN`, `BUNNY_API_KEY`.
2. **Run `bash secrets/deploy.sh`** — applies all migrations, sets secrets
   (incl. Clerk JWKS/issuer), deploys all three Workers. **Ship the new APK at the
   same time** — the compat layer is gone and the app now signs NIP-98 + Clerk JWT
   and routes the relay by pubkey.
3. **Build the APK on CI** and run the on-device smoke test (login → profile →
   resolve/add contact → DM media → 1:1 call → push wake).
4. **Delete `avaglobal` + `avablobal`** in the RealtimeKit dashboard (can't be done
   via API). Keep `avatok-calls`.

## 7. Known limitations / future watch

- Stream **recording** content scan is stubbed (image scan + pHash are live).
- pHash matches resize/recompress, **not crops** — expected for DCT pHash.
- Socket attachment cap (~2 KB) holds a normal client's subscription filters; a
  pathological huge-filter client would need subs moved to DO storage.
- iOS push (APNs) code is complete but gated off until a `.p8` key is provided
  (Android-first).
- A lighter NSFW image classifier isn't in the account's Workers AI catalog yet;
  the vision model is the interim, with the swap path ready.
