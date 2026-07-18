// listing_enrichment.ts — compose-greeting enrichment for a SELLER composing their
// OWN listing. PLAN-2026-07-17-ai-listing-creation §1.2 (rewrite), §1.2b, §6.1.
//
// Two tiers, one goal: hand the compose /session greeting a *small*, typed hint —
// "you've listed 3 flats before, you usually list in Hindi" — while never becoming a
// profile and never breaking the flow when the brain is absent.
//
//   Tier A  the seller's OWN listing history. Plain D1, uid-scoped, NO brain, NO gate,
//           NO consent (it's their own authored rows). Always attempted.
//   Tier B  preference enrichment from AvaBrain recall, behind FOUR independent gates
//           (§6.1). Any gate failing → Tier B is silently skipped and Tier A stands
//           alone. Same "degrade to asking" path as §1.2.
//
// Hard boundaries (§1.2b, §6.1 — do NOT relax):
//   • Only ever the seller's OWN `uid`. Never another user's uid; never cross-user.
//     (Cross-user price comparables are the *opposite* case and are forbidden from
//      touching recall — see §1.2b(a). This helper is the seller's own memory, which
//      §1.2 explicitly permits under the `listings` consent.)
//   • `domains` is HARD-CODED to ['listings'] — never a parameter, never anything else.
//     Wallet / contacts / calls / orientation must not surface in a listing composer.
//     Returned hits are additionally re-filtered to domain==='listings' as belt-and-braces.
//   • k = 5 (≤5). Never an unscoped recall.
//   • We return only the small typed shape below — never raw hits, scores, ts, or any
//     text that could carry another domain's content.
//   • Everything is wrapped so a brain outage NEVER errors the caller. The whole point
//     of §1.2 is that compose /session works with no brain at all.

import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { consentKeyFor, type BrainConsentKey } from "./brain_domains";
import { metaDb } from "../db/shard";

/** The small, greeting-facing shape. Nothing here can leak a non-`listings` domain. */
export interface ListingEnrichment {
  /** How many listings this seller has authored in THIS vertical (Tier A). */
  priorCount: number;
  /** Their most-used categories in this vertical, most-frequent first (Tier A). */
  recentCategories: string[];
  /** Language habit, if the brain surfaced one (Tier B). */
  lang?: string;
  /** A coarse location hint, if the brain surfaced one (Tier B). */
  locationHint?: string;
  /** One short brain-derived note the greeting may weave in (Tier B). */
  note?: string;
}

// The `listings` domain is a registry constant (One Brain §3). Resolve its consent key
// from the single source of truth rather than hard-coding the string, so a registry
// rename can't silently un-gate this. This is `'listings'` today.
const LISTINGS_CONSENT: BrainConsentKey | null = consentKeyFor("listings");

// ── Tier A ──────────────────────────────────────────────────────────────────
// The seller's own authored rows, filtered to the vertical. A plain uid-scoped D1
// aggregate — no brain, no consent gate beyond them being the author.
async function ownHistory(
  env: Env,
  uid: string,
  vertical: string,
): Promise<{ priorCount: number; recentCategories: string[] }> {
  try {
    const rs = await metaDb(env)
      .prepare(
        `SELECT category, COUNT(*) AS n
           FROM listings
          WHERE creator_id = ?1 AND vertical = ?2
          GROUP BY category
          ORDER BY n DESC`,
      )
      .bind(uid, vertical)
      .all<{ category: string | null; n: number }>();

    const rows = (rs.results ?? []) as Array<{ category: string | null; n: number }>;
    let priorCount = 0;
    const recentCategories: string[] = [];
    for (const r of rows) {
      priorCount += Number(r.n) || 0;
      const c = (r.category ?? "").trim();
      if (c && recentCategories.length < 3) recentCategories.push(c);
    }
    return { priorCount, recentCategories };
  } catch {
    // Own-history read failed → treat as no history. Never throw at the caller.
    return { priorCount: 0, recentCategories: [] };
  }
}

// ── Gate 2 — the seller's `listings` brain consent (canonical server read) ────
// Mirrors the canonical fail-closed read used by brainIngest's consentAllows and the
// /api/brain consent route: the `brain_consent` table, checking BOTH the `master`
// switch AND the domain's consent key. Absence of a row = default ON (opt-out model);
// enabled=0 on either = OFF. Any D1 error → false (fail closed).
async function listingsConsentOn(env: Env, uid: string): Promise<boolean> {
  if (!LISTINGS_CONSENT) return false; // no consent key ⇒ nothing lawful to gate on
  try {
    const rs = await env.DB_BRAIN.prepare(
      "SELECT capability, enabled FROM brain_consent WHERE uid=?1 AND capability IN (?2, ?3)",
    )
      .bind(uid, "master", LISTINGS_CONSENT)
      .all<{ capability: string; enabled: number }>();
    for (const r of (rs.results ?? []) as Array<{ enabled: number }>) {
      if (Number(r.enabled) === 0) return false;
    }
    return true;
  } catch {
    return false; // FAIL CLOSED
  }
}

// ── Gates 3 + 4 — the recall itself ───────────────────────────────────────────
// Reuses the exact UserBrain DO invocation pattern from routes/brain.ts::toBrain:
// POST {uid, op:'recall', query, domains, k} to the DO stub keyed by the SELLER's uid.
//   • domains is HARD-CODED ['listings'] (§6.1 gate 4) — never a parameter.
//   • k = 5 (≤5) — never an unscoped recall.
//   • Gate 3 (B4 shipped): if the op isn't wired the DO answers non-200 / no hits — we
//     treat that as "absent", not an error, and Tier B is skipped.
// Returns only the mapped Tier-B fields; raw hits never escape this function.
async function brainPreferences(
  env: Env,
  uid: string,
): Promise<{ lang?: string; locationHint?: string; note?: string } | null> {
  try {
    const stub = env.USER_BRAIN.get(env.USER_BRAIN.idFromName(uid));
    const res = await stub.fetch("https://brain/op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        uid,
        op: "recall",
        query: "listing language location categories the seller usually lists",
        domains: ["listings"], // HARD-CODED — the only domain this composer may see
        k: 5, // ≤ 5, never unscoped
      }),
    });
    // Gate 3: op unavailable (404) or any DO error → absent, not a failure.
    if (!res.ok) return null;

    const data = (await res.json().catch(() => null)) as
      | { hits?: Array<{ text?: unknown; domain?: unknown }> }
      | null;
    if (!data || !Array.isArray(data.hits) || data.hits.length === 0) return null;

    // Belt-and-braces: even though we asked for ['listings'], drop anything not tagged
    // `listings` before it can touch the greeting. Nothing from another domain leaks.
    const listingHits = data.hits.filter((h) => String(h?.domain ?? "") === "listings");
    if (listingHits.length === 0) return null;

    // Map to the small shape. We surface ONE short note (the top hit, trimmed) — never
    // scores, ts, or the raw hit array. lang/locationHint stay absent unless a future
    // structured recall provides them; we do not fabricate them from free text.
    const topText = String(listingHits[0]?.text ?? "").trim();
    if (!topText) return null;
    return { note: topText.slice(0, 200) };
  } catch {
    // Brain outage / DO throw — Tier B is a nicety; never surface it to the caller.
    return null;
  }
}

/**
 * Compose-greeting enrichment for a seller composing their OWN listing.
 *
 * @param env      Worker env (D1 + USER_BRAIN DO + config KV).
 * @param uid      The SELLER's uid. MUST be the composer's own uid — never another user's.
 * @param vertical The marketplace vertical being composed in; Tier A is scoped to it.
 * @returns        A small ListingEnrichment, or `null` when there's nothing useful
 *                 (no own history AND no usable brain hint). Never throws.
 */
export async function listingEnrichment(
  env: Env,
  uid: string,
  vertical: string,
): Promise<ListingEnrichment | null> {
  if (!uid || !vertical) return null;

  // Tier A — always attempted, no gate.
  const tierA = await ownHistory(env, uid, vertical);

  // Tier B — four independent gates; any failure silently drops it.
  let tierB: { lang?: string; locationHint?: string; note?: string } | null = null;
  try {
    // Gate 1 — the dedicated enrichment flag (§6.1 gate 1). Read live config; default
    // false. Its own switch, deliberately NOT aiComposeEnabled.
    const cfg = await readConfig(env);
    if (cfg.listingBrainEnrichmentEnabled) {
      // Gate 2 — the seller's `listings` brain consent (canonical fail-closed read).
      if (await listingsConsentOn(env, uid)) {
        // Gates 3 + 4 — recall exists (B4) AND is domain-scoped ['listings'], k≤5.
        tierB = await brainPreferences(env, uid);
      }
    }
  } catch {
    tierB = null; // any surprise in the Tier-B path degrades to Tier A alone
  }

  const out: ListingEnrichment = {
    priorCount: tierA.priorCount,
    recentCategories: tierA.recentCategories,
  };
  if (tierB?.lang) out.lang = tierB.lang;
  if (tierB?.locationHint) out.locationHint = tierB.locationHint;
  if (tierB?.note) out.note = tierB.note;

  // Nothing useful in either tier → null (the AI asks a question instead, §1.2).
  const useful =
    out.priorCount > 0 ||
    out.recentCategories.length > 0 ||
    out.lang != null ||
    out.locationHint != null ||
    out.note != null;
  return useful ? out : null;
}
