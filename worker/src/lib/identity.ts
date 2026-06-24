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

const NAME_PREFIX = "ph_name:"; // KV key namespace (uid → first name, "" = none)

/**
 * uid → the user's first/display name, KV-cached like [emailFor]. Used so the
 * receptionist can greet a caller BY NAME ("Hi Humphrey, …") — resolved from
 * Clerk (first_name → username → null). A cached empty string = known absent.
 */
export async function nameFor(env: Env, uid: string): Promise<string | null> {
  if (!uid) return null;
  const key = NAME_PREFIX + uid;
  try {
    const cached = await env.TOKENS.get(key);
    if (cached !== null) return cached === "" ? null : cached;
  } catch { /* fall through to a live lookup */ }
  let name: string | null = null;
  try {
    const u = await clerkUser(env, uid);
    if (u) {
      const first = (u.first_name ?? "").toString().trim();
      const uname = (u.username ?? "").toString().trim();
      name = first || uname || null;
    }
  } catch { /* best-effort */ }
  try { await env.TOKENS.put(key, name ?? "", { expirationTtl: TTL_SECONDS }); } catch { /* best-effort */ }
  return name;
}
