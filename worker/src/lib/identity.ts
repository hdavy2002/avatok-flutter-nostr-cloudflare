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

/** Fetch the user's primary email address from Clerk (raw — telemetry only). */
async function clerkEmail(env: Env, uid: string): Promise<string | null> {
  if (!env.CLERK_SECRET_KEY) return null;
  try {
    const r = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(uid)}`, {
      headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
    });
    if (!r.ok) return null;
    const u = (await r.json()) as any;
    const addrs = (u.email_addresses ?? []) as any[];
    const primary = addrs.find((e) => e.id === u.primary_email_address_id) ?? addrs[0];
    return primary?.email_address ?? null;
  } catch {
    return null;
  }
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
