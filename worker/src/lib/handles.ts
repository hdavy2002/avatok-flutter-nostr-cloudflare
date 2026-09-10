// [WEB-HANDLE-1] Auto-assign a stable @handle to every user.
//
// Handles were retired as the in-app identity (see routes/api.ts's
// `handleCheck`/HANDLE_RE comment — "Handles are retired site-wide",
// Specs/AVATOK-NUMBER-FEATURE-SPEC.md). That stands for the APP: the
// AvaTOK number remains the in-app identity, and `/api/handle/check`
// stays deprecated/410.
//
// SUPERSEDED FOR THE WEB (owner decision 2026-09-10): the website needs a
// stable, human-readable, URL-safe identity per creator — pretty listing
// URLs (/<handle>/<slug>), creator pages (/c/<handle>), and the creators
// sitemap all key off `users.handle`. This module gives every user a
// handle without ever contradicting the in-app retirement: it never
// exposes a picker, never lets a user change an existing handle, and
// never touches a guest (guests already choose their own handle via the
// L0 ladder in routes/ladder.ts).
//
// Design constraints (all deliberate):
//   - IDEMPOTENT: if users.handle is already set, return it UNCHANGED.
//     Shared URLs depend on a handle never moving under someone's feet.
//   - NEVER THROWS: a handle is a nice-to-have for the web surface, not a
//     dependency of profile save or listing publish. Every failure mode
//     here is swallowed and logged; callers just get `null` back.
//   - Written exactly like a chosen handle: same `users.handle` column,
//     same `identity_proofs(uid, proof='handle', ...)` row (mirrors the
//     INSERT pattern in routes/ladder.ts's guestCreate/guestUpgrade), so a
//     generated handle is indistinguishable downstream from one a user
//     picked themselves.
import type { Env } from "../types";
import { metaDb } from "../db/shard";

// Handle = 3–20 chars, lowercase letters/digits/underscore, starts with a
// letter. SOURCE OF TRUTH: routes/api.ts's `HANDLE_RE` (~line 2696). Copied
// here rather than imported to keep this module import-light and because
// api.ts is a large route file we should not need to touch again for this
// to keep working; keep the two in sync if either changes.
const HANDLE_RE = /^[a-z][a-z0-9_]{2,19}$/;
const MAX_LEN = 20;

// Handles double as the first path segment of pretty listing URLs
// (/<handle>/<slug>, web/src/lib/urls.ts). A handle equal to a top-level web
// route would shadow it (or be shadowed by it), so those words are never
// auto-assigned. Keep in sync with web/src/pages/* top-level names plus the
// obvious brand/infra words. A human who picks one of these via the guest
// ladder is that flow's problem; this list only guards generation.
const RESERVED = new Set([
  'about','acceptable_use','add','admin','agent','api','app','archive','ava','avatok',
  'biometric_retention','blog','book','c','careers','child_safety','community_guidelines',
  'consult','consultation_terms','contact','cookies','creator','creators','dashboard','dmca',
  'e','embed','explore','forgot_password','grievance','help','ideas','index','j','l','live','login','marketplace',
  'marketplace_terms','pay','payouts','pricing','pricing_fees','privacy','recording','refunds',
  'session','sign_in','sign_out','sign_up','signin','signup','sitemap','sso_callback','support',
  'terms','tokens','vision','watch','www',
]);

/**
 * Build a candidate handle base from a display name, or first+last name.
 * Lowercase, diacritics stripped (NFKD, combining marks removed), only
 * [a-z0-9_] kept, runs collapsed, leading digits/underscores stripped so
 * the result starts with a letter (HANDLE_RE requirement), cut to 20
 * chars. Returns null when nothing usable survives (< 3 chars).
 */
export function slugifyHandle(
  displayName?: string | null,
  first?: string | null,
  last?: string | null,
): string | null {
  const source = (displayName && displayName.trim())
    || [first, last].filter((s) => s && s.trim()).join(" ").trim()
    || "";
  if (!source) return null;

  let s = source
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")    // anything not [a-z0-9_] -> underscore
    .replace(/_+/g, "_")             // collapse runs
    .replace(/^[^a-z]+/, "")         // strip leading digits/underscores
    .replace(/_+$/, "");             // trim a trailing underscore left by the strip above

  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN).replace(/_+$/, "");
  if (s.length < 3) return null;
  return s;
}

function randDigits(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 10).toString();
  return out;
}

/**
 * Idempotently ensure `uid` has a handle. Returns the handle (existing or
 * newly assigned) or null if assignment was skipped/failed — NEVER throws.
 *
 * - uids starting with 'guest:' are skipped (guests choose their own handle
 *   in routes/ladder.ts's L0 flow) and this returns null immediately.
 * - If users.handle is already set, it is returned unchanged — this
 *   function never overwrites an existing handle.
 * - Otherwise a base is slugified from `opts` (falling back to the row's
 *   own display_name/first_name/last_name when opts are omitted), or
 *   'creator' when no usable name exists anywhere, and a handle is claimed
 *   by trying the base, then base+2 random digits, then +3, then +4
 *   (trimming the base so the total never exceeds 20 chars), for up to
 *   ~8 attempts total. Each attempt is a conditional UPDATE
 *   (`WHERE uid=?1 AND handle IS NULL`) so a concurrent racer can never
 *   clobber a handle written in between; a UNIQUE-constraint error on the
 *   handle column is treated as a collision and the next candidate is tried.
 * - On success, an `identity_proofs` row is written the same way
 *   routes/ladder.ts writes one for a chosen handle.
 */
export async function ensureHandle(
  env: Env,
  uid: string,
  opts?: { displayName?: string | null; firstName?: string | null; lastName?: string | null },
): Promise<string | null> {
  try {
    if (!uid || uid.startsWith("guest:")) return null;

    const db = metaDb(env);
    const row = await db.prepare(
      "SELECT handle, display_name, first_name, last_name FROM users WHERE uid=?1",
    ).bind(uid).first<{ handle: string | null; display_name: string | null; first_name: string | null; last_name: string | null }>();

    // No users row at all yet — nothing to attach a handle to. Callers hook
    // this in AFTER their own upsert/publish succeeds, so this should be
    // rare; fail closed rather than inserting a bare row ourselves.
    if (!row) return null;
    if (row.handle) return row.handle; // already set — never overwrite

    let base = slugifyHandle(
      opts?.displayName ?? row.display_name,
      opts?.firstName ?? row.first_name,
      opts?.lastName ?? row.last_name,
    );
    if (!base || RESERVED.has(base)) base = base ? `${base}_` : "creator";
    // A reserved base still gets a suffix below because the bare `base`
    // candidate is filtered out here; "creator" alone is reserved too, so the
    // no-name case always lands on creator<digits>.

    const candidates: string[] = RESERVED.has(base.replace(/_+$/, "")) ? [] : [base];
    // 2, then 3, then 4 random digits; several attempts at each width so a
    // single unlucky collision doesn't burn the whole width. ~8 attempts total.
    for (const width of [2, 2, 3, 3, 4, 4, 4]) {
      const trimmedBase = base.length + width > MAX_LEN ? base.slice(0, MAX_LEN - width) : base;
      candidates.push(`${trimmedBase}${randDigits(width)}`);
    }

    const now = Date.now();
    for (const candidate of candidates) {
      if (!HANDLE_RE.test(candidate)) continue; // never assign a handle that fails the strict regex
      try {
        const res = await db.prepare(
          "UPDATE users SET handle=?2, updated_at=?3 WHERE uid=?1 AND handle IS NULL",
        ).bind(uid, candidate, now).run();
        if (!(res.meta?.changes ?? 0)) {
          // Either the row vanished, or a concurrent write already set a
          // handle (ours or someone else's) — re-check rather than assume
          // it was a collision on `candidate` itself.
          const recheck = await db.prepare("SELECT handle FROM users WHERE uid=?1")
            .bind(uid).first<{ handle: string | null }>();
          if (recheck?.handle) return recheck.handle; // someone else won the race — that's fine
          continue; // row missing or transient — try the next candidate
        }
        try {
          await db.prepare(
            `INSERT INTO identity_proofs (uid, proof, status, provider, verified_at, updated_at)
             VALUES (?1,'handle','verified','system',?2,?2)
             ON CONFLICT(uid, proof) DO UPDATE SET status='verified', provider='system', verified_at=?2, updated_at=?2`,
          ).bind(uid, now).run();
        } catch (e) {
          // The handle write already landed; a failure here only means the
          // ladder proof lags — log and keep the handle.
          console.warn("[WEB-HANDLE-1] ensureHandle: identity_proofs write failed for", uid, e);
        }
        return candidate;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (/UNIQUE|constraint/i.test(msg) && /handle/i.test(msg)) continue; // collision — try next candidate
        console.warn("[WEB-HANDLE-1] ensureHandle: write error for", uid, msg.slice(0, 200));
        return null;
      }
    }
    console.warn("[WEB-HANDLE-1] ensureHandle: exhausted candidates for", uid);
    return null;
  } catch (e) {
    console.warn("[WEB-HANDLE-1] ensureHandle: unexpected failure for", uid, e);
    return null;
  }
}
