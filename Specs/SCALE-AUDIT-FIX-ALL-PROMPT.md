# AvaTalk — Scale Audit Fix-All Prompt

**Purpose:** Fix EVERY item from SCALE_AUDIT.md. All 12. No deferrals. The builder has full context right now — do it while that's true.

**CRITICAL RULE: Do NOT rebuild or re-scaffold anything. The backend is done. You are fixing specific, identified issues in existing code. Each fix is surgical.**

**Execute in this order. Test after each fix. Do not batch.**

---

## Fix 1 — P0-2: D1 100-parameter limit (LAUNCH BLOCKER)

**The bug:** D1 rejects queries with >100 bound parameters. Two places build `IN (?)` from unbounded input:
- `worker/src/routes/api.ts › matchContacts()` — takes up to 5000 phone hashes, puts them all in one `IN (?)`. Any user with >100 contacts → query crashes.
- `relay/src/relay_do.ts › queryFilter()` — binds client filter arrays (ids, authors, kinds, #p, #e) directly. A user following >100 people → feed query crashes.

**The fix:**
- Write a `chunkedQuery` helper that splits an array into batches of 90, runs a separate query per batch, and unions the results (deduped).
- Apply it to `matchContacts()` — chunk phone_hash array into batches of 90, query each batch, merge results.
- Apply it to `queryFilter()` — chunk authors, ids, and tag value arrays into batches of 90. For multi-filter queries (authors + kinds), keep kinds in every batch (they're small arrays), only chunk the large arrays.
- Dedupe results by event_id (relay) or npub (contacts) after merging.

**Test:** Create a mock request with 150 phone hashes → should return results, not crash. Create a relay REQ with 150 authors → should return events, not throw.

---

## Fix 2 — P1-6: Verify Blossom R2 cache rule

**Check:** Go to Cloudflare Dashboard → Caching → Cache Rules. Confirm there is a rule for `blossom.avatok.ai` with:
- Cache eligibility: Cache Everything
- Edge TTL: at least 30 days (ideally `max-age=31536000, immutable` since content is addressed by sha256 hash — the content at a given URL never changes)
- Browser TTL: at least 1 day

**If the rule exists:** confirm and move on.
**If missing:** create it via the Cloudflare MCP or dashboard. This is the single biggest cost lever for media — without it, every image view is an R2 Class B read + origin round-trip instead of a free edge cache hit.

Also confirm Smart Tiered Cache is enabled for the zone.

---

## Fix 3 — P0-1: Relay sharding (per-user inbox DO)

**This is the biggest change. The current single-DO relay is an architectural ceiling.**

**Current design (broken at scale):** One DO (`idFromName("relay-global")`) handles every WebSocket connection on the planet. One single-threaded isolate, one location, broadcasts iterate all connected sockets per event.

**New design: per-user inbox DO.**

Each user connects to their own DO, keyed by their pubkey: `idFromName(userPubkey)`. This gives you millions of tiny DOs, each handling one user's connection, each hibernating when idle.

**Architecture:**

```
User A publishes kind-1 event (public post):
  → A's inbox DO receives it
  → Persist to D1 (nostr_events + nostr_tags) — same as today
  → Done. No fan-out for public posts.
  → Readers fetch via REQ → D1 query (same as today)

User A publishes kind-1059 event (DM to user B):
  → A's inbox DO receives it
  → Persist to D1
  → Read #p tag → recipient is B
  → Forward event to B's inbox DO: env.RELAY.get(env.RELAY.idFromName(B_pubkey))
  → B's inbox DO wakes from hibernation, delivers to B's WebSocket
  → Push notification via Q_PUSH (same as today)

User B sends REQ for their feed (authors=[...200 follows], kinds=[1]):
  → B's inbox DO receives the REQ
  → Query D1 directly (already chunked per Fix 1)
  → Return results to B's WebSocket
  → Done. No broadcast needed.
```

**Key changes:**
- `relay/src/index.ts` — route WebSocket upgrade to `idFromName(authenticatedPubkey)` instead of `idFromName("relay-global")`.
- `relay/src/relay_do.ts` — each DO handles ONE user's connections (could be multiple devices). Remove the global `broadcast()` loop. Replace with: on publish, persist to D1, then fan out DMs/mentions to recipient DOs via stub calls.
- NIP-42 auth happens FIRST (before routing to the user's DO), so you know which pubkey to route to. Or do auth inside the DO and reject if the claimed pubkey doesn't match the DO's key.
- REQ queries go straight to D1 from the user's DO — same queries as today, same indexes.
- Public event notification (someone I follow posted): NOT real-time fan-out. The client polls or the next REQ picks it up. This is how Nostr works — REQ-based, not push-based for public content. Real-time delivery is only for DMs and mentions (events with a #p tag pointing at you).

**What stays the same:**
- D1 schema (nostr_events, nostr_tags) — unchanged
- D1 queries — unchanged (but now run from per-user DOs instead of one global DO)
- NIP-42 auth logic — unchanged
- Event validation/signature verification — unchanged
- Push notification via Q_PUSH — unchanged

**What changes:**
- Routing: per-user instead of global
- Broadcast: eliminated for public posts, targeted fan-out for DMs/mentions
- Connection state: each DO holds only that user's connections (1-3 devices typically)

**Hibernation still applies** — each per-user DO hibernates when the user's not active. Most users are idle most of the time, so most DOs are hibernated.

**Test:** Two test users, each connects to their own relay DO. User A publishes a kind-1 event → persists to D1 → User B's next REQ returns it. User A sends a kind-1059 DM to User B → B's DO wakes up and delivers it in real-time. Verify both DOs hibernate when idle.

---

## Fix 4 — P1-3: Search full-table scan → FTS5

**The bug:** `search()` uses `LIKE '%q%'` which scans the entire profiles table. At scale this reads millions of rows per search.

**The fix:** Add an FTS5 virtual table for profile search.

```sql
-- Add to meta.sql migration
CREATE VIRTUAL TABLE IF NOT EXISTS profiles_fts USING fts5(
  npub UNINDEXED,
  handle,
  display_name,
  content=profiles,
  content_rowid=rowid
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS profiles_ai AFTER INSERT ON profiles BEGIN
  INSERT INTO profiles_fts(rowid, npub, handle, display_name)
  VALUES (new.rowid, new.npub, new.handle, new.display_name);
END;

CREATE TRIGGER IF NOT EXISTS profiles_ad AFTER DELETE ON profiles BEGIN
  INSERT INTO profiles_fts(profiles_fts, rowid, npub, handle, display_name)
  VALUES ('delete', old.rowid, old.npub, old.handle, old.display_name);
END;

CREATE TRIGGER IF NOT EXISTS profiles_au AFTER UPDATE ON profiles BEGIN
  INSERT INTO profiles_fts(profiles_fts, rowid, npub, handle, display_name)
  VALUES ('delete', old.rowid, old.npub, old.handle, old.display_name);
  INSERT INTO profiles_fts(rowid, npub, handle, display_name)
  VALUES (new.rowid, new.npub, new.handle, new.display_name);
END;
```

Update `search()` in the API worker:
```javascript
// Before (full scan):
// WHERE handle LIKE '%q%' OR LOWER(display_name) LIKE '%q%'

// After (indexed FTS):
// SELECT p.* FROM profiles p
// JOIN profiles_fts f ON p.npub = f.npub
// WHERE profiles_fts MATCH ?
```

FTS5 `MATCH` supports prefix queries (`dav*`), phrase queries, and is index-backed. No full table scan.

**Test:** Insert 100 test profiles, search for a partial name → should return results from the FTS index, not a table scan. Verify the trigger fires on insert/update/delete.

---

## Fix 5 — P1-4: pHash blocklist → LSH banding

**The bug:** `matchesBlockedPerceptual()` loads up to 5000 hashes from the blocklist and Hamming-compares each one in JavaScript. O(n) per upload, stops working past 5000 entries.

**The fix:** Locality-Sensitive Hashing (LSH) with band indexing.

Split each 64-bit perceptual hash into 4 bands of 16 bits each. Store each band as a separate row in a new `blocked_phash_bands` table:

```sql
CREATE TABLE IF NOT EXISTS blocked_phash_bands (
  band_index  INTEGER NOT NULL,    -- 0, 1, 2, 3
  band_value  TEXT NOT NULL,       -- 16-bit hex substring
  hash_id     TEXT NOT NULL,       -- FK to blocked_media_hashes.id
  full_hash   TEXT NOT NULL,       -- the complete 64-bit pHash for final verify
  PRIMARY KEY (band_index, band_value, hash_id)
);
CREATE INDEX IF NOT EXISTS idx_phash_band ON blocked_phash_bands(band_index, band_value);
```

**Lookup:** For an uploaded image's pHash, split it into 4 bands, query candidates that match ANY band, then Hamming-verify only the candidates:

```javascript
// 1. Split upload pHash into 4 bands
const bands = splitIntoBands(uploadHash, 4);

// 2. Find candidates matching any band (indexed lookup, not full scan)
const candidates = await db.prepare(`
  SELECT DISTINCT full_hash, hash_id FROM blocked_phash_bands
  WHERE (band_index = 0 AND band_value = ?)
     OR (band_index = 1 AND band_value = ?)
     OR (band_index = 2 AND band_value = ?)
     OR (band_index = 3 AND band_value = ?)
`).bind(...bands).all();

// 3. Hamming-verify only candidates (typically 0-5, not 5000)
for (const c of candidates.results) {
  if (hammingDistance(uploadHash, c.full_hash) <= 6) return true;
}
return false;
```

This turns O(n) into O(1) indexed lookups + O(tiny) verification. Scales to millions of blocked hashes.

When adding a new hash to the blocklist, also insert its 4 bands into `blocked_phash_bands`.

**Test:** Add 10 blocked hashes, upload an image with Hamming distance ≤6 from one of them → should match via band lookup, not full scan.

---

## Fix 6 — P1-5: Vision model cost tracking + lighter model swap path

**No code rewrite needed.** The model is already a config variable (`MODERATION_MODEL`). Three changes:

1. **Track neuron spend.** After each AI inference, log the neuron count to Analytics Engine (`env.ANALYTICS.writeDataPoint({ blobs: ['moderation'], doubles: [neuronCount] })`). This gives you a dashboard of AI cost before it surprises you on the bill.

2. **Skip scanning for verified users (tier-2).** In the moderation consumer, check the uploader's tier from DB_META. If `tier = 'verified'`, still scan but use a lighter threshold (flag at 0.90 instead of 0.60). Verified users have proven identity — they're less likely to upload harmful content and more accountable if they do.

3. **Document the swap path.** Add a comment in the moderation consumer: when a lighter NSFW classifier appears on Workers AI (e.g., `falcons-ai/nsfw-image-detection` or similar), swap `MODERATION_MODEL` in wrangler.toml vars. The input/output format may differ — the `classify()` function needs to handle both the vision-LLM response format (text parsing) and a classifier response format (label + score). Add a model-type flag alongside the model name.

---

## Fix 7 — P1-7: Skip R2 re-fetch for known hashes

**The bug:** `handleModeration()` always fetches the blob from R2 and decodes it with Photon to compute pHash, even when the sha256 is already in `moderation_results` (meaning it was scanned before).

**The fix:** Check `moderation_results` FIRST. If the sha256 exists there AND a pHash is already stored, skip the R2 fetch + Photon decode entirely. Return the cached result.

Add a `phash` column to `moderation_results`:

```sql
ALTER TABLE moderation_results ADD COLUMN phash TEXT;
```

Update the moderation flow:
1. Check `moderation_results` by sha256
2. If found with non-null phash → use cached AI result + cached pHash, skip R2 fetch
3. If not found → fetch from R2, run AI scan, compute pHash, store both in `moderation_results`

This saves an R2 Class B read + WASM Photon decode on every re-upload of identical content.

---

## Fix 8 — P2-8: PostHog batch endpoint

**The bug:** The analytics consumer sends one HTTP POST per event to PostHog. The queue already delivers messages in batches of up to 50.

**The fix:** Collect all events from the batch, send one POST to PostHog's `/batch` endpoint:

```javascript
// Before: loop + individual capture()
// After: one batch call
const events = batch.map(msg => ({
  event: msg.body.event,
  properties: msg.body.properties,
  distinct_id: msg.body.distinct_id,
  timestamp: msg.body.timestamp
}));

await fetch('https://app.posthog.com/batch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ api_key: env.POSTHOG_API_KEY, batch: events })
});
```

50x fewer HTTP calls to PostHog per queue batch.

---

## Fix 9 — P2-10: Partial index for moderation cleanup cron

**The bug:** The 6-hour cron cleanup scans `user_media` by `moderation_status` with no dedicated index.

**The fix:** Add a partial index:

```sql
CREATE INDEX IF NOT EXISTS idx_media_pending
ON user_media(moderation_status, created_at)
WHERE moderation_status IN ('pending', 'rejected');
```

This covers the cron's query without indexing the vast majority of rows (which are `'live'` or `'skipped'`).

---

## Fix 10 — P2-11: Wire Analytics Engine or drop the binding

**The binding `ANALYTICS` (Analytics Engine dataset `avatok_metrics`) exists but is never called.**

**Wire it.** Add `writeDataPoint` calls in key places:

- API Worker: log request latency + route name on every response (`ctx.waitUntil`)
- Relay DO: log event count per kind on publish
- Moderation consumer: log AI neuron spend (from Fix 6) + scan duration
- Push consumer: log push success/failure counts
- Cron: log cleanup row counts

Pattern:
```javascript
ctx.waitUntil(
  env.ANALYTICS.writeDataPoint({
    blobs: [routeName, method],
    doubles: [latencyMs],
    indexes: ['api_latency']
  })
);
```

This gives you operational dashboards via the Analytics Engine SQL API without blowing PostHog's event budget on system metrics.

---

## Fix 11 — P2-9: Read-your-writes note (documentation only)

**No code change.** Add a comment in `db/shard.ts` explaining:

- `withSession("first-unconstrained")` gives read-after-write consistency WITHIN a single request (the session bookmark tracks writes done in that request).
- ACROSS requests, a read immediately after a write (different HTTP request) may briefly hit a lagged replica. This is fine for 99% of flows.
- For the rare flow that needs cross-request consistency (e.g., "I just registered, now load my profile in the next page"), the client can retry once after a short delay, or the response can include the created data directly (which it already does for register and profile-set).

---

## Fix 12 — P2-12: Relay shard trigger documentation

**No code change.** Add a comment in `db/shard.ts` documenting the concrete threshold:

- When `nostr_events` exceeds ~5 GB (check via `SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()` in D1), switch `relayDbFor()` to time-based sharding: events before the cutoff date → DB_RELAY_ARCHIVE, events after → DB_RELAY.
- Add DB_RELAY_ARCHIVE as a second D1 database in wrangler.toml when needed.
- The sharding router is already written — it's a config change, not a rewrite.

---

## Rules for this session

1. **Test after each fix.** Don't batch 12 fixes and deploy once.
2. **Each fix gets its own commit message.** "Fix P0-2: chunk D1 params to 90", "Fix P1-3: FTS5 profile search", etc.
3. **Do not change anything outside the scope of each fix.** No refactors, no "while I'm here" improvements.
4. **The relay sharding (Fix 3) is the biggest change.** Take your time on it. Get the per-user inbox DO routing right, test DM fan-out thoroughly, verify hibernation works on the new per-user DOs.
5. **Migrations (FTS5, phash bands, moderation_results phash column) go in new migration files**, not by editing existing ones. Name them: `meta_fts.sql`, `moderation_lsh.sql`, `moderation_phash_col.sql`.
6. **All Workers must pass `tsc --noEmit` and `wrangler deploy --dry-run` after each fix.**
7. **Update SCALE_AUDIT.md** — mark each item as fixed with a one-line note of what was done.
8. **Update BACKEND_REBUILD_HANDOFF.md** §10 with a Session 3 section listing all fixes.
