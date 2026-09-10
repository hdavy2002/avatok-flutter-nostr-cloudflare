// [WEB-HANDLE-1] One-off backfill: assign a stable @handle to every existing
// users row that doesn't have one yet.
//
// This script does NOT talk to D1 itself (no wrangler, no fetch, no deps) — it
// is a pure text transform: JSON in, SQL out. The coordinator runs it in two
// steps:
//
//   1) Produce the input JSON with the wrangler CLI (or the D1 REST API —
//      either way, this script only cares that the result is the wrangler
//      `--json` shape, or a bare {results:[...]} / array-of-rows fallback):
//
//        wrangler d1 execute avatok-meta --remote --json \
//          --command "SELECT uid, handle, display_name, first_name, last_name FROM users" \
//          > /tmp/users_for_handle_backfill.json
//
//   2) Generate the SQL and apply it:
//
//        node worker/scripts/backfill_handles.mjs /tmp/users_for_handle_backfill.json \
//          > /tmp/handle_backfill.sql
//        wrangler d1 execute avatok-meta --remote --file=/tmp/handle_backfill.sql
//
// Rows skipped: any row that already has a handle, and any 'guest:' uid
// (guests already choose their own handle via the L0 ladder in
// routes/ladder.ts — this backfill must never touch them).
//
// Determinism: a re-run against the same input (same rows still handle-less)
// produces the SAME output SQL, because the random-looking numeric suffix on
// collision is seeded from a hash of the uid, not Math.random(). That makes
// this script safe to run, review, and re-run without the output silently
// drifting.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// ── slugify — MIRRORS worker/src/lib/handles.ts's slugifyHandle(). Kept as an
// inline copy (not imported) so this script has zero dependency on a TS build
// step and can run under plain `node`. Keep the two in sync if either changes.
const MAX_LEN = 20;
// Handle = 3–20 chars, lowercase letters/digits/underscore, starts with a
// letter. SOURCE OF TRUTH: worker/src/routes/api.ts's HANDLE_RE.
const HANDLE_RE = /^[a-z][a-z0-9_]{2,19}$/;

function slugifyHandle(displayName, first, last) {
  const source = (displayName && displayName.trim())
    || [first, last].filter((s) => s && s.trim()).join(" ").trim()
    || "";
  if (!source) return null;

  let s = source
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "");

  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN).replace(/_+$/, "");
  if (s.length < 3) return null;
  return s;
}

// Deterministic 0-9 digit stream seeded from uid + a salt, so re-runs are stable.
function seededDigits(uid, salt, n) {
  const hash = createHash("sha256").update(`${uid}:${salt}`).digest("hex");
  let out = "";
  for (let i = 0; i < n; i++) {
    // two hex chars -> 0-255 -> mod 10, walking further into the hash per digit
    const byte = parseInt(hash.slice((i * 2) % (hash.length - 2), (i * 2) % (hash.length - 2) + 2), 16);
    out += (byte % 10).toString();
  }
  return out;
}

function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

// ── Load + normalize the input JSON into a flat array of row objects ────────
function loadRows(jsonPath) {
  const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
  // wrangler `d1 execute --json` shape: an array of per-statement results,
  // each with a `results` array of row objects.
  if (Array.isArray(raw) && raw.length && raw[0] && Array.isArray(raw[0].results)) {
    return raw[0].results;
  }
  // Bare { results: [...] } (e.g. a single REST API response).
  if (raw && Array.isArray(raw.results)) return raw.results;
  // Bare array of row objects.
  if (Array.isArray(raw)) return raw;
  throw new Error("Unrecognized JSON shape — expected wrangler `d1 execute --json` output, {results:[...]}, or an array of rows.");
}

function main() {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error("Usage: node worker/scripts/backfill_handles.mjs <users.json>");
    process.exit(1);
  }
  const rows = loadRows(jsonPath);

  const existingHandles = new Set();
  for (const r of rows) {
    if (r.handle) existingHandles.add(String(r.handle).toLowerCase());
  }

  const now = Date.now();
  const sqlLines = [];
  let nFromName = 0;
  let nFallback = 0;
  let nSkippedHasHandle = 0;
  let nSkippedGuest = 0;
  let nSkippedUnassignable = 0;

  for (const r of rows) {
    const uid = String(r.uid ?? "");
    if (!uid) continue;
    if (r.handle) { nSkippedHasHandle++; continue; }
    if (uid.startsWith("guest:")) { nSkippedGuest++; continue; }

    let base = slugifyHandle(r.display_name, r.first_name, r.last_name);
    const fromName = !!base;
    // Mirrors RESERVED in src/lib/handles.ts — a handle must never equal a
    // top-level web route (it is the first segment of /<handle>/<slug>).
    const RESERVED = new Set(['about','acceptable_use','add','admin','agent','api','app','archive','ava','avatok',
  'biometric_retention','blog','book','c','careers','child_safety','community_guidelines',
  'consult','consultation_terms','contact','cookies','creator','creators','dashboard','dmca',
  'e','embed','explore','forgot_password','grievance','help','ideas','index','j','l','live','login','marketplace',
  'marketplace_terms','pay','payouts','pricing','pricing_fees','privacy','recording','refunds',
  'session','sign_in','sign_out','sign_up','signin','signup','sitemap','sso_callback','support',
  'terms','tokens','vision','watch','www',
    ]);
    if (!base || RESERVED.has(base)) base = base ? `${base}_` : "creator_";

    // Candidate order mirrors lib/handles.ts's ensureHandle: base, then +2,
    // +3, +4 seeded digits, deterministic per-uid so re-runs are stable.
    const candidates = RESERVED.has(base.replace(/_+$/, "")) ? [] : [base];
    for (const width of [2, 2, 3, 3, 4, 4, 4]) {
      const trimmedBase = base.length + width > MAX_LEN ? base.slice(0, MAX_LEN - width) : base;
      candidates.push(`${trimmedBase}${seededDigits(uid, `w${width}`, width)}`);
    }

    let assigned = null;
    for (const candidate of candidates) {
      if (!HANDLE_RE.test(candidate)) continue;
      if (existingHandles.has(candidate)) continue;
      assigned = candidate;
      break;
    }
    if (!assigned) { nSkippedUnassignable++; continue; }

    existingHandles.add(assigned); // reserve within this run so later rows don't collide with it
    if (fromName) nFromName++; else nFallback++;

    const esc = sqlEscape(assigned);
    const uidEsc = sqlEscape(uid);
    sqlLines.push(
      `UPDATE users SET handle='${esc}', updated_at=${now} WHERE uid='${uidEsc}' AND handle IS NULL;`,
    );
    sqlLines.push(
      `INSERT INTO identity_proofs (uid, proof, status, provider, verified_at, updated_at) VALUES ('${uidEsc}','handle','verified','system',${now},${now}) ON CONFLICT(uid, proof) DO NOTHING;`,
    );
  }

  process.stdout.write(sqlLines.join("\n") + (sqlLines.length ? "\n" : ""));

  const nTotal = rows.length;
  const nAssigned = nFromName + nFallback;
  console.error(
    `[backfill_handles] rows=${nTotal} assigned=${nAssigned} (from_name=${nFromName} fallback=${nFallback}) ` +
    `skipped_has_handle=${nSkippedHasHandle} skipped_guest=${nSkippedGuest} skipped_unassignable=${nSkippedUnassignable}`,
  );
}

main();
