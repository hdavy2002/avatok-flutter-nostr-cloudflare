// identity.ts — resolve a user's raw email for TELEMETRY only.
//
// D1 stores only sha256(email) (privacy), so the raw email lives in Clerk. To
// let support "pull errors by email" in PostHog we resolve uid → email via the
// Clerk API and cache it in the TOKENS KV so we don't hit Clerk on every turn.
// Best-effort everywhere: any failure returns null and telemetry simply omits
// the email (the chat path is never blocked or slowed by this).

import type { Env } from "../types";

const TTL_SECONDS = 6 * 60 * 60; // 6h — emails change rarely; keep Clerk load low
const CACHE_PREFIX = "ph_email:"; // KV key namespace (uid → email, "" = none)
const PHONE_PREFIX = "ph_phone:"; // KV key namespace (uid → phone, "" = none)

/** Fetch the user's full Clerk record once (raw — telemetry only). */
async function clerkUser(env: Env, uid: string): Promise<any | null> {
  if (!env.CLERK_SECRET_KEY) return null;
  try {
    const r = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(uid)}`, {
      headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
    });
    if (!r.ok) return null;
    return (await r.json()) as any;
  } catch {
    return null;
  }
}

/** Fetch the user's primary email address from Clerk (raw — telemetry only). */
async function clerkEmail(env: Env, uid: string): Promise<string | null> {
  const u = await clerkUser(env, uid);
  if (!u) return null;
  const addrs = (u.email_addresses ?? []) as any[];
  const primary = addrs.find((e) => e.id === u.primary_email_address_id) ?? addrs[0];
  return primary?.email_address ?? null;
}

/** Fetch the user's primary phone number from Clerk (E.164 raw — telemetry only). */
async function clerkPhone(env: Env, uid: string): Promise<string | null> {
  const u = await clerkUser(env, uid);
  if (!u) return null;
  const nums = (u.phone_numbers ?? []) as any[];
  const primary = nums.find((p) => p.id === u.primary_phone_number_id) ?? nums[0];
  return primary?.phone_number ?? null;
}

/**
 * [ACCT-RELINK-1] The user's PRIMARY email from Clerk, but ONLY if that address is
 * verified. Used by /api/me to relink a returning login (which arrives under a NEW
 * Clerk id) back to an existing account by email. Deliberately NOT KV-cached and
 * verification-checked: this gates account access, so it must be fresh and must
 * never trust an unverified address (which could hijack someone else's account).
 * Returns null when there is no key, the lookup fails, or the primary email is
 * unverified. Called only on the rare /api/me miss, so an uncached Clerk call is fine.
 */
export async function primaryVerifiedEmailFor(env: Env, uid: string): Promise<string | null> {
  const u = await clerkUser(env, uid);
  if (!u) return null;
  const addrs = (u.email_addresses ?? []) as any[];
  const primary = addrs.find((e) => e.id === u.primary_email_address_id) ?? addrs[0];
  if (!primary?.email_address) return null;
  const verified = primary?.verification?.status === "verified";
  return verified ? String(primary.email_address) : null;
}

/**
 * uid → email, cached in KV. Returns null when unknown (no Clerk key, lookup
 * failed, or the user has no email). A cached empty string means "known absent"
 * and short-circuits repeat Clerk calls.
 */
export async function emailFor(env: Env, uid: string): Promise<string | null> {
  if (!uid) return null;
  const key = CACHE_PREFIX + uid;
  try {
    const cached = await env.TOKENS.get(key);
    if (cached !== null) return cached === "" ? null : cached;
  } catch { /* fall through to a live lookup */ }
  const email = await clerkEmail(env, uid);
  try { await env.TOKENS.put(key, email ?? "", { expirationTtl: TTL_SECONDS }); } catch { /* best-effort */ }
  return email;
}

/**
 * uid → phone (E.164), cached in KV exactly like [emailFor]. Returns null when
 * unknown. A cached empty string means "known absent" and short-circuits repeats.
 */
export async function phoneFor(env: Env, uid: string): Promise<string | null> {
  if (!uid) return null;
  const key = PHONE_PREFIX + uid;
  try {
    const cached = await env.TOKENS.get(key);
    if (cached !== null) return cached === "" ? null : cached;
  } catch { /* fall through to a live lookup */ }
  const phone = await clerkPhone(env, uid);
  try { await env.TOKENS.put(key, phone ?? "", { expirationTtl: TTL_SECONDS }); } catch { /* best-effort */ }
  return phone;
}

/** Resolve BOTH email + phone for telemetry in one go (each KV-cached). */
export async function contactFor(env: Env, uid: string): Promise<{ email: string | null; phone: string | null }> {
  const [email, phone] = await Promise.all([emailFor(env, uid), phoneFor(env, uid)]);
  return { email, phone };
}

// v4 prefix: bumped by [CALL-IDENTITY-SNAPSHOT-1] because v3 entries were
// populated by the OLD Clerk-first resolver and are therefore poisoned with
// identity-provider names. A prefix bump is the only safe invalidation — there
// is no enumeration of the old keys.
const NAME_PREFIX = "ph_name4:"; // KV key namespace (uid → first name, "" = none)
const PROFILE_PREFIX = "ph_prof1:"; // uid → JSON public identity snapshot

/** A usable name token: trimmed, non-empty, and NOT email/handle-looking.
 *  Greeting "Hi hdavy2002@gmail.com" is worse than no name at all. */
function asNameToken(raw: unknown): string | null {
  const t = (raw ?? "").toString().trim();
  if (!t || t.includes("@")) return null;
  return t;
}

/**
 * [CALL-IDENTITY-SNAPSHOT-1 2026-08-01] The AvaTOK PUBLIC PROFILE identity —
 * the "YOUR PUBLIC CARD" screen the user actually edits (first name, last name,
 * avatar). This is the ONLY server-side identity source on the call path.
 *
 * WHY THIS EXISTS. `nameFor()` used to ask Clerk FIRST and only fall back to the
 * profile table. So a caller whose AvaTOK profile said "Arti Singh" was announced
 * to the callee as "Davy" — her Google account's first name. Your Gmail identity
 * leaking to everyone you call is not acceptable, and it is not a precedence bug
 * to be re-tuned: per Specs/CALL-OUTCOMES-FROZEN-2026-08-01.md freeze decision 6,
 * the identity provider is REMOVED as a permissible runtime source, not demoted.
 * Clerk may seed a profile name at onboarding; after that it is not consulted.
 *
 * Returns null only when the user has no profile row at all.
 */
export type PublicIdentity = {
  uid: string;
  /** Full display name for UI — "Arti Singh", not just "Arti". */
  display_name: string | null;
  /** First name only, for a spoken greeting — "Hi Arti". */
  greeting_name: string | null;
  avatar_url: string | null;
  /** Stable cache key component. Changes when the avatar changes, so a client
   *  disk cache can be keyed `avatar:{uid}:{avatar_version}` rather than on the
   *  URL — CDN query strings and transforms change while the image does not. */
  avatar_version: string | null;
  profile_version: number;
  resolved_at: number;
};

export async function publicIdentityFor(env: Env, uid: string): Promise<PublicIdentity | null> {
  if (!uid) return null;
  const key = PROFILE_PREFIX + uid;
  try {
    const cached = await env.TOKENS.get(key);
    if (cached !== null) {
      if (cached === "") return null; // known-absent
      return JSON.parse(cached) as PublicIdentity;
    }
  } catch { /* fall through to a live lookup */ }

  let row: {
    display_name?: string | null; first_name?: string | null; last_name?: string | null;
    avatar_url?: string | null; handle?: string | null; updated_at?: number | null;
  } | null = null;
  try {
    row = await env.DB_META
      .prepare("SELECT display_name, first_name, last_name, avatar_url, handle, updated_at FROM users WHERE uid=?1")
      .bind(uid)
      .first();
  } catch { /* best-effort — a D1 hiccup must never block a call */ }
  if (!row) {
    try { await env.TOKENS.put(key, "", { expirationTtl: 60 }); } catch { /* best-effort */ }
    return null;
  }

  // Prefer the explicit first+last the user typed on the public card; fall back
  // to display_name, then handle. Never Clerk.
  const first = asNameToken(row.first_name);
  const last = asNameToken(row.last_name);
  const composed = [first, last].filter(Boolean).join(" ").trim();
  const display = composed || asNameToken(row.display_name) || asNameToken(row.handle);
  const greeting = first
    || (display ? display.split(/\s+/)[0] : null);

  const avatarUrl = (row.avatar_url ?? "").toString().trim() || null;
  // Version the avatar so the client cache key is stable across CDN transforms.
  // `updated_at` moves whenever the profile is saved, which is exactly when the
  // avatar can have changed; a hash of the URL covers rows with no updated_at.
  const avatarVersion = avatarUrl
    ? String(row.updated_at ?? 0) + ":" + String(avatarUrl.length) + avatarUrl.slice(-12)
    : null;

  const snap: PublicIdentity = {
    uid,
    display_name: display,
    greeting_name: greeting,
    avatar_url: avatarUrl,
    avatar_version: avatarVersion,
    profile_version: Number(row.updated_at ?? 0),
    resolved_at: Date.now(),
  };
  // Short TTL: a profile edit must show up on the next call, not in 6 hours.
  try { await env.TOKENS.put(key, JSON.stringify(snap), { expirationTtl: 300 }); } catch { /* best-effort */ }
  return snap;
}

/**
 * uid → the user's FIRST name for a spoken greeting ("Hi Arti, …"), KV-cached.
 *
 * [CALL-IDENTITY-SNAPSHOT-1] Now resolved from the AvaTOK public profile ONLY.
 * The Clerk lookup that used to run first has been DELETED — see
 * [publicIdentityFor] for why. A cached empty string = known absent, and the
 * greeting gracefully degrades to "Hi there".
 */
export async function nameFor(env: Env, uid: string): Promise<string | null> {
  if (!uid) return null;
  const key = NAME_PREFIX + uid;
  try {
    const cached = await env.TOKENS.get(key);
    if (cached !== null) return cached === "" ? null : cached;
  } catch { /* fall through to a live lookup */ }
  const snap = await publicIdentityFor(env, uid);
  const name = snap?.greeting_name ?? null;
  try { await env.TOKENS.put(key, name ?? "", { expirationTtl: TTL_SECONDS }); } catch { /* best-effort */ }
  return name;
}
