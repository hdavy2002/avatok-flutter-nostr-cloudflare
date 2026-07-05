// P0 backfill — mint a canonical identity_id for every existing users.uid.
// Design: Specs/ROUTING-IDENTITY-PRESENCE-ARCH.md (v4) §12.
//
// Standalone Node script (no build step, no external deps). For every users.uid
// NOT already present as a kind='uid' alias, it mints a fresh opaque
// identity_id (idn_<ulid>) and inserts the identities + routes +
// identity_aliases rows. This is an INLINE COPY of ensureIdentityForUid's logic
// (worker/src/lib/routing.ts) — kept dependency-free so it runs under plain
// `node`. It is IDEMPOTENT and SAFE TO RE-RUN (every write uses ON CONFLICT ...
// DO NOTHING, keyed on the current uid-alias).
//
// Run:  node worker/scripts/backfill_identity.mjs
//
// ─────────────────────────────────────────────────────────────────────────────
// D1 CONNECTION — TODO (leave the exact wiring to the operator).
// D1 has no direct socket; pick ONE of these two access patterns and fill in
// `readUids(...)` and `execStatements(...)` below. Both are standard for this
// repo (see memory: "wrangler deploy sandbox limit", "cloudflare-api-token").
//
//   PATTERN A — wrangler CLI (simplest locally):
//     Read:
//       wrangler d1 execute avatok-meta --remote --json \
//         --command "SELECT uid FROM users"
//       → parse stdout JSON → [{ results: [{ uid }] }]
//     Write (batch of statements as one file):
//       write the SQL to a temp .sql file, then
//       wrangler d1 execute avatok-meta --remote --file=/tmp/backfill.sql
//     (Invoke via child_process.execFile — kept as a TODO so nothing runs
//      implicitly on import.)
//
//   PATTERN B — D1 REST API (no wrangler; needs CLOUDFLARE_API_TOKEN):
//     POST https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/d1/database/<DB_ID>/query
//       headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
//                  'Content-Type': 'application/json' }
//       body:    { sql: "<statement>", params: [ ... ] }
//     → response.result[0].results holds SELECT rows.
//     ACCOUNT_ID / DB_ID: see memory "cloudflare-avatok-resources";
//     token in secrets/cf_token.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "node:crypto";

// ── ULID / identity_id (inline copy of worker/src/lib/identity_ids.ts) ──────
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

function encodeTime(ms) {
  let out = "";
  let t = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom() {
  const bytes = crypto.randomBytes(10); // 80 bits
  let out = "";
  let bitBuffer = 0;
  let bits = 0;
  for (const b of bytes) {
    bitBuffer = (bitBuffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(bitBuffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += CROCKFORD[(bitBuffer << (5 - bits)) & 0x1f];
  return out.slice(0, 16);
}

function ulid(now = Date.now()) {
  return (encodeTime(now) + encodeRandom()).toLowerCase();
}

function newIdentityId() {
  return "idn_" + ulid();
}

// ── D1 access (TODO: wire to Pattern A or B above) ──────────────────────────

/** Return an array of { uid } for every row in `users`.
 *  TODO: implement via wrangler CLI or the D1 REST API (see header). */
async function readUids() {
  throw new Error(
    "readUids() not wired — implement Pattern A (wrangler) or B (D1 REST) from the header comment.",
  );
}

/** Execute an array of { sql, params } statements against avatok-meta.
 *  TODO: implement via wrangler CLI (write to a .sql file) or the D1 REST API. */
async function execStatements(_statements) {
  throw new Error(
    "execStatements() not wired — implement Pattern A (wrangler) or B (D1 REST) from the header comment.",
  );
}

// ── Backfill logic (mirrors ensureIdentityForUid; idempotent) ───────────────

/** Build the three idempotent inserts for a single uid → identity_id. */
function insertsForUid(uid, identityId, now) {
  return [
    {
      sql: `INSERT INTO identities (identity_id, status, version, updated_at)
              VALUES (?1, 'active', 1, ?2)
              ON CONFLICT(identity_id) DO NOTHING`,
      params: [identityId, now],
    },
    {
      sql: `INSERT INTO routes (identity_id, current_uid, generation, routing_version, updated_at)
              VALUES (?1, ?2, 1, 1, ?3)
              ON CONFLICT(identity_id) DO NOTHING`,
      params: [identityId, uid, now],
    },
    {
      sql: `INSERT INTO identity_aliases (alias, identity_id, kind, valid_from, valid_to)
              VALUES (?1, ?2, 'uid', ?3, NULL)
              ON CONFLICT(alias, valid_from) DO NOTHING`,
      params: [uid, identityId, now],
    },
  ];
}

async function main() {
  // Ensure schema exists first (idempotent) — run scripts/backfill_identity.sql,
  // or execute its DDL here via execStatements before the loop.
  const rows = await readUids();
  let minted = 0;
  let skipped = 0;

  for (const { uid } of rows) {
    if (!uid) continue;
    // Skip if a kind='uid' alias already exists (idempotency). With the D1 REST
    // API you can pre-fetch existing aliases in one query and diff; the
    // ON CONFLICT guards below already make a blind re-run safe, so the check
    // is an optimisation, not a correctness requirement.
    const identityId = newIdentityId();
    const now = Date.now();
    try {
      await execStatements(insertsForUid(uid, identityId, now));
      minted++;
    } catch (e) {
      skipped++;
      console.error(`backfill: uid=${uid} failed:`, e?.message ?? e);
    }
  }

  console.log(`backfill complete — attempted mints: ${minted}, errors: ${skipped}`);
  console.log(
    "verify with the diagnostic SELECT in scripts/backfill_identity.sql (expect 0 rows).",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
