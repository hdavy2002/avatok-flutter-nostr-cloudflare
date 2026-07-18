-- [AVA-MKT-COMPOSE-1] listing_compose_sessions + listing_compose_turns.
--
-- GENUINELY NEW SCHEMA. Two tables that have never existed on any database.
-- Phase 2 of Specs/PLAN-2026-07-17-ai-listing-creation-DRAFT.md (§3.3, §3.3b,
-- §3.3c). DB: avatok-meta (DB_META) — the same database as migrations/listings.sql
-- and the Phase 1 taxonomy set, which this file extends. Apply listings.sql and
-- the Phase 1 set first.
--
-- WHY — "the LLM never holds the draft. The server does." (plan §3.3, called out
-- there as the single most important architectural decision in the plan.) These
-- two tables ARE that decision made physical: the draft, the pinned category
-- version, the turn counter and the optimistic `rev` all live in D1, and the model
-- is handed a prompt built from them on every turn. A model that holds the draft
-- in its context loses the seller's work on one malformed turn (`callSonnet`
-- returns "" on any error today — marketplace.ts:535-547) and has no way to be
-- resumed, retried, versioned or deleted. A draft in a row has all four.
--
-- Precedent: `avachat_sessions` (worker/src/routes/ava_chat_history.ts:25) — but
-- the POST-B0 version, i.e. THIS FILE, a real migration. Explicitly NOT the
-- `ensureTable()`-at-request-time pattern: schema that only exists after the first
-- request is schema no migration runner, no fresh DB and no reviewer can see.
--
-- ---------------------------------------------------------------------------
-- THE TRANSCRIPT IS SCRATCH, NOT MEMORY. RETENTION IS A REQUIREMENT, NOT A CHORE.
-- (plan §3.3b — read it before touching `transcript` or `listing_compose_turns`.)
--
-- "Chat content never lives server-side" (One Brain B-D1) and "transcript in D1"
-- only stop contradicting each other if the retention rules below are ENFORCED
-- rather than asserted. The plan's own words: the listing is the artifact, the
-- transcript is packaging. Three obligations land on code that is NOT in this file
-- (a migration cannot enforce any of them) and are recorded here so that whoever
-- wires them can see what the schema is promising:
--
--   1. NULL `transcript` ON TERMINAL STATE. The moment a session reaches
--      `published` or `abandoned`, `transcript` is set to NULL in the same write.
--      The draft survives — it is the listing. The conversation does not.
--
--   2. 72h TTL OTHERWISE. `expires_at = created_at + 72h` on every session (that
--      is why the column is NOT NULL — a session with no deadline is a session
--      that is never purged). A nightly job nulls `transcript` past `expires_at`
--      and marks the session `abandoned`. `idx_compose_expiry` exists ONLY to make
--      that job a cheap range scan; if you are adding the job, that index is your
--      driver.
--
--   3. `listing_compose_sessions` IS A TARGET OF THE ONE BRAIN DELETION JOB
--      (One Brain §5.1) — an idempotent step like every other store, so "delete my
--      data" reaches compose. THIS IS THE POINT OF THE WHOLE PARAGRAPH: One Brain
--      §5.1 exists precisely BECAUSE `avachat_sessions` became a store nobody
--      remembered to purge. Adding a second one, in the migration that had the
--      chance to say so, would be the same bug twice. `listing_compose_turns` is a
--      target too — see its own header; response_json is transcript-grade content.
--
-- COMPOSE IS DELIBERATELY **NOT** A `BRAIN_DOMAINS` ENTRY. Do not add one.
-- Only the FINISHED LISTING is ingested, under the `listings` domain (plan §1.2).
-- The transcript is never passed to `brainIngest`. This is not an oversight to be
-- helpfully corrected later: the scratch never becomes memory, and the absence of
-- a compose entry in `BRAIN_DOMAINS` is the enforcement.
--
-- Access is `uid`-scoped, with NO admin/support read path. If moderation later
-- needs "how was this written", it gets the draft revisions, not the chat.
-- ---------------------------------------------------------------------------
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENCY — this file is NATIVELY safe to re-run, like its verticals sibling.
--
-- Every statement is CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- There is no ALTER here, so there is no "duplicate column name" failure mode and
-- NOTHING to guard:
--   * FRESH / STAGING / PROD (absent)  -> creates. Correct.
--   * RE-RUN (present)                 -> every statement is a no-op. Correct.
--   * PARTIAL (table present, an index missing, or vice versa) -> converges.
--
-- There are no seed rows: a compose session is user data, never a fixture. If a
-- future edit adds a seed here it MUST be INSERT OR IGNORE, never OR REPLACE —
-- REPLACE on a re-run would clobber live rows (see the verticals migration header
-- for why that rule is load-bearing across this whole set).
--
--   RUN IT RAW — this file is CREATE only, so it does NOT go through
--   scripts/d1_apply_alters.py (that runner parses ALTERs and ONLY ALTERs, and
--   exits with "no ALTER TABLE ... ADD COLUMN statements" on this file, by design):
--     scripts/cf.sh worker d1 execute DB_META --remote \
--       --file=migrations/2026-07-18-listing-compose-sessions.sql
--
-- The ALTERs for this phase live in 2026-07-18-listings-mandate-columns.sql.
-- Keep the split: mixing a CREATE into an ALTER file means the guarded runner
-- silently skips it while the raw path runs it — two runners producing two
-- different databases from one file.
--
-- Goes through scripts/cf.sh, so staging is the default and prod is fail-closed
-- behind ALLOW_PROD=1. Pass the BINDING (DB_META), not a database name — prod is
-- `avatok-meta`, staging is `avatok-meta-staging`; the binding resolves per --env.
--
-- Apply order (Phase 2, after the whole Phase 1 set):
--   1. listings.sql                              (base tables)
--   2. 2026-07-18-listings-drift-columns.sql     (via d1_apply_alters.py)
--   3. 2026-07-18-listings-content-version.sql   (via d1_apply_alters.py)
--   4. 2026-07-18-marketplace-verticals.sql      (raw --file)
--   5. 2026-07-18-listings-taxonomy-columns.sql  (via d1_apply_alters.py)
--   6. 2026-07-18-listings-taxonomy-seed.sql     (raw --file)
--   7. THIS FILE                                 (raw --file)
--   8. 2026-07-18-listings-mandate-columns.sql   (via d1_apply_alters.py)
-- 7 and 8 are independent of each other; both need 1-6.
-- ---------------------------------------------------------------------------

-- === listing_compose_sessions ==============================================
--
-- Plan §3.3. The server-owned state machine. Column order and types follow the
-- plan's DDL exactly.
CREATE TABLE IF NOT EXISTS listing_compose_sessions (
  session_id  TEXT PRIMARY KEY,

  -- The author. Every read is scoped by this and there is no second read path —
  -- see the access rule in the header. Clerk user id, matching every other
  -- per-user table here (marketplace_agent_settings.user_id, etc.).
  uid         TEXT NOT NULL,

  -- The DRAFT listing row, created on the first `set_core` — not at session
  -- start. NULLABLE because a session legitimately exists before there is
  -- anything to create a listing from: the seller has said "a flat in Bandra"
  -- and nothing else yet. A NULL here means "no listing row exists yet", which
  -- is why publish cannot be reached from it.
  listing_id  TEXT,

  -- listing_categories.id. NULL until the AI has mapped the opening turn to a
  -- category (or filed it under `other` + proposed_category, plan §2.3 — the
  -- user is never blocked by a missing category).
  category    TEXT,

  -- PINNED AT SESSION START (§2.4), not read live per turn. Same clock as
  -- listings.cat_version: the session validates `attrs` against the field_schema
  -- as it was when the seller started talking. An admin editing a category
  -- mid-session must not change the questions the seller is halfway through
  -- answering — that is a silently corrupted draft, and the seller sees a form
  -- that mutates under them. NOT NULL with no DEFAULT is deliberate: the server
  -- always knows this at INSERT (it just resolved the category to build the
  -- prompt), and a defaulted 1 would quietly mis-pin a session on a category
  -- that has moved on.
  cat_version INTEGER NOT NULL,

  -- BCP-47. The language the CONVERSATION is in, which is NOT the language the
  -- listing is stored in (plan §3.7: converse in the user's language, store the
  -- listing in English + original, with the original in attrs.orig_lang /
  -- attrs.title_orig). NULL = not yet detected from the first turn. The user may
  -- switch mid-chat, so this is mutable and is not a pin.
  lang        TEXT,

  -- JSON. The accumulating listing — the answers so far, in the §2.2 attrs shape
  -- plus the core fields. THIS IS THE THING THE MODEL DOES NOT HOLD. NOT NULL:
  -- an empty draft is '{}', never NULL, so every reader can parse unconditionally
  -- instead of every reader inventing its own null-check.
  --
  -- SURVIVES the transcript. On publish/abandon the transcript is nulled and this
  -- column is not, because this is the artifact.
  draft_json  TEXT NOT NULL,

  -- JSON. Last ~20 turns. **SCRATCH — see the retention block in the header.**
  -- NOT NULL is per the plan's DDL, and it does NOT contradict "nulled on
  -- publish/abandon": SQLite NOT NULL is enforced per-write, and the terminal
  -- write is the one that sets '' / '[]'. If you are wiring the deletion job and
  -- find NOT NULL fighting you, write '[]' (empty, parseable, no content) rather
  -- than reaching for an ALTER to drop the constraint — the constraint is what
  -- stops a reader ever meeting a NULL transcript it did not expect.
  --
  -- REDACTION IS ON WRITE, NOT ON READ (§3.3b). The same precheck that strips PII
  -- from a description (marketplace.ts:737) runs BEFORE the turn is persisted, so
  -- a phone number the seller typed never lands in this column in the first
  -- place. Redacting on read would mean the raw number is in D1 forever and the
  -- protection is one buggy SELECT away from gone. No encryption at rest beyond
  -- D1's own: encrypting a 72-hour buffer we can already delete is theatre, and
  -- the key would live next to the data.
  transcript  TEXT NOT NULL,

  -- §3.3c. Client-incremented per turn. Half of the idem_key
  -- (hash(session_id, turn_seq, text)) — see listing_compose_turns.
  turn_seq    INTEGER NOT NULL DEFAULT 0,

  -- §3.3c. OPTIMISTIC VERSION. Every write asserts the rev it read; a mismatch is
  -- 409 stale_session + the current draft, and the client re-renders rather than
  -- clobbering. Two app instances in one session converge instead of racing.
  -- Also the publish latch: draft->published is ONE conditional write
  -- (WHERE status='active' AND rev=?), so a double-tapped publish button
  -- publishes once.
  rev         INTEGER NOT NULL DEFAULT 0,

  -- 'active' | 'published' | 'abandoned'. No CHECK constraint, matching the rest
  -- of this schema (listings.status is unconstrained too) — the enum is enforced
  -- in the route, and a CHECK here would have to be recreated via a table rebuild
  -- the first time a state is added, which is exactly the kind of migration this
  -- set exists to avoid.
  --
  -- Both terminal states null the transcript. `abandoned` is reached two ways: the
  -- user walks away and the TTL job marks it, or they explicitly discard.
  status      TEXT NOT NULL,

  created_at  INTEGER,   -- epoch ms
  updated_at  INTEGER,   -- epoch ms; drives idx_compose_uid's resume ordering

  -- created_at + 72h. NOT NULL — a session without a deadline is a session that
  -- is never purged, and the retention promise in §3.3b is only as good as this
  -- constraint. See obligation 2 in the header.
  expires_at  INTEGER NOT NULL
);

-- Plan §3.3: "resume the newest `active` session on reopen" — "You were listing a
-- 3-bed in Bandra. Carry on?". That query is
-- (uid=? AND status='active' ORDER BY updated_at DESC LIMIT 1), and this index
-- serves it as a one-row lookup instead of a scan of every session the user has
-- ever opened. Deliberately NOT (uid, status, updated_at): status is low
-- cardinality and skewed, a user has a handful of sessions, and the plan names
-- this index shape — keep it matching.
CREATE INDEX IF NOT EXISTS idx_compose_uid ON listing_compose_sessions(uid, updated_at DESC);

-- THE RETENTION INDEX. Sole purpose: make the nightly TTL job
-- (WHERE expires_at < ? AND status='active') a range scan. Without it the job is
-- a full table scan that gets slower exactly as the table gets bigger, i.e. it
-- degrades precisely when the retention promise matters most. If you are the
-- person wiring that job, this index is the reason it is cheap.
CREATE INDEX IF NOT EXISTS idx_compose_expiry ON listing_compose_sessions(expires_at);

-- === listing_compose_turns =================================================
--
-- Plan §3.3c. THE IDEMPOTENCY LEDGER. Not a chat log — a replay cache.
--
-- WHAT IT IS FOR: a retried request, a flaky connection or a double-tapped send
-- must not re-run the model. `idem_key = hash(session_id, turn_seq, text)`; the
-- unique index below is the enforcement, and a replay returns THE STORED RESPONSE
-- rather than calling avaReason again. Same shape as One Brain §3.2's ingest
-- idempotency — deliberately, so there is one pattern to learn.
--
-- Re-running the model on a retry is not merely wasteful, it is WRONG: a second
-- non-deterministic answer to a question the user already answered would apply
-- the model's tool_calls to the draft a second time (a second set_fields, a second
-- attach_media), so the retry would silently mutate state the first call already
-- mutated. Idempotency here is a correctness control, not a cost control.
--
-- ---------------------------------------------------------------------------
-- WHAT MUST BE STORED TO REPLAY A TURN FAITHFULLY — AND WHAT MUST NOT.
--
-- A faithful replay means: the client cannot tell the replay from the original.
-- That requires exactly three things, and they are the three columns below.
--
--   1. `response_json` — THE RESPONSE BODY, VERBATIM, AS IT WAS SENT.
--      The whole envelope { say, chips[], draft_progress, missing[], done? },
--      serialized, not the ingredients to rebuild it. Storing the model's
--      tool_calls and re-deriving the reply would re-run the derivation against a
--      draft that has MOVED ON since (a later turn changed it), so the replay
--      would return a different answer to the same idem_key — which is precisely
--      the thing the unique index promises cannot happen. Store the output, not
--      the recipe.
--
--   2. `status_code` — the HTTP status that accompanied it.
--      Without this a replay of a turn that returned 409 stale_session or a
--      422 validation failure comes back as 200, and the client that retried
--      because it never saw the first response now believes a rejected turn was
--      accepted. The status IS part of the response; splitting them makes the
--      replay a different event from the original.
--
--   3. `rev_after` — the session `rev` this turn left behind.
--      The replay's own consistency check, and the audit trail for "which write
--      produced this response". A retry arriving after the client has advanced can
--      compare `rev_after` against what it holds and know whether it is behind,
--      without another round trip. It is also what makes a partially-applied turn
--      diagnosable at all: response says X, session sits at Y, so the write landed
--      and the response did not.
--
-- AND WHAT IS DELIBERATELY ABSENT: **the seller's request text.**
-- `idem_key` is already hash(session_id, turn_seq, text) — the hash is sufficient
-- to detect a replay, so storing the plaintext buys nothing and costs the entire
-- §3.3b argument. The transcript is the ONE place the conversation lives, it is
-- nulled on publish/abandon, and a turns table quietly holding a verbatim copy of
-- every seller utterance would mean "we deleted the transcript" was false the day
-- it was written. Do not add a `text` column here. If you need the conversation,
-- it is in `listing_compose_sessions.transcript`, under that column's rules.
--
-- `response_json` IS ITSELF TRANSCRIPT-GRADE CONTENT — the model's `say` quotes
-- the listing copy back at the seller. So this table inherits the SAME retention
-- rules, and it is a One Brain §5.1 deletion target in its own right, not merely a
-- child of the session. That is what `expires_at` + `idx_compose_turns_expiry`
-- below are for. A deletion job that purges sessions and leaves the turns behind
-- has deleted the index and kept the content.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listing_compose_turns (
  -- listing_compose_sessions.session_id. NO FOREIGN KEY, matching this schema's
  -- convention (see listing_category_versions' header for the same call): D1's
  -- FK enforcement + a cascade would make the deletion job's ordering load-bearing
  -- and its failure modes silent. The job deletes both tables explicitly and
  -- idempotently instead — which is what One Brain §5.1 requires anyway, so the
  -- FK would be buying an implicit version of a step that must exist explicitly.
  session_id    TEXT NOT NULL,

  -- hash(session_id, turn_seq, text) — §3.3c. Computed CLIENT-side and asserted
  -- server-side. Includes the text, so an edited retry of the same turn_seq is
  -- correctly a NEW turn rather than a replay of the old one.
  idem_key      TEXT NOT NULL,

  -- Denormalized from the key for ordering and debugging ("which turn was this?").
  -- Not part of the uniqueness contract — (session_id, idem_key) is.
  turn_seq      INTEGER NOT NULL,

  -- (1) The stored response. See the block above: verbatim, not re-derived.
  response_json TEXT NOT NULL,

  -- (2) The HTTP status it was sent with. DEFAULT 200 so the common path need not
  -- say so, but error responses MUST record their real status or the replay lies.
  status_code   INTEGER NOT NULL DEFAULT 200,

  -- (3) The session rev this turn left behind.
  rev_after     INTEGER,

  created_at    INTEGER NOT NULL,   -- epoch ms

  -- Mirrors the session's expires_at. DENORMALIZED ON PURPOSE: it makes the TTL
  -- purge a single indexed DELETE on this table with no join back to sessions, so
  -- turns cannot outlive the transcript they echo just because a join was
  -- forgotten. The retention promise should not depend on getting a join right.
  expires_at    INTEGER NOT NULL
);

-- THE IDEMPOTENCY CONTRACT, in one line of DDL. Plan §3.3c, verbatim:
--   CREATE UNIQUE INDEX idx_compose_turn ON listing_compose_turns(session_id, idem_key);
-- UNIQUE is not an optimization here, it is the control: the INSERT is what CLAIMS
-- the turn. The route inserts FIRST and treats a uniqueness violation as "this is
-- a replay -> SELECT response_json and return it", which makes the claim atomic in
-- the database rather than in a check-then-act window where two retries both read
-- "not present" and both call the model. Check-then-act would double-charge the
-- model call and double-apply the tool_calls under exactly the flaky-connection
-- conditions this table exists for.
CREATE UNIQUE INDEX IF NOT EXISTS idx_compose_turn ON listing_compose_turns(session_id, idem_key);

-- Retention driver for this table — the sibling of idx_compose_expiry, and for the
-- same reason: response_json is content, so its purge must be as cheap as the
-- transcript's or it will be the step that gets skipped.
CREATE INDEX IF NOT EXISTS idx_compose_turns_expiry ON listing_compose_turns(expires_at);
