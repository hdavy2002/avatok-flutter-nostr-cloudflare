// [HF-PAGES-2] Registration / re-accept pins now come from the database, not from file hashes.
//
// Each of the five agreements maps to a policy page in D1 `site_pages` (HF-PAGES-1). Its pin is
//     site:<slug>:<material_version>
// `material_version` only goes up when an admin saves an edit with `material: true`
// (PUT /api/admin/hf/pages/:slug). Ordinary edits bump `version` (what readers see) but NOT the pin, so
// fixing a typo never asks anybody to accept again. A material edit changes the pin, and every registered
// user is then asked once to accept it (GET/POST /api/hf/me/policy-update).
import type { Env } from "../types";

export const HF_POLICY_SLUGS = {
  terms: "terms",
  privacy: "privacy",
  disclaimer: "disclaimer",
  community: "community-guidelines",
  engagement: "rules-of-engagement",
} as const;
const PATHS = {
  terms: "/terms", privacy: "/privacy", disclaimer: "/disclaimer", community: "/community-guidelines", engagement: "/rules-of-engagement",
} as const;

export type RegistrationPolicy = keyof typeof HF_POLICY_SLUGS;
export const REGISTRATION_POLICY_NAMES = Object.keys(HF_POLICY_SLUGS) as RegistrationPolicy[];

/**
 * LEGACY (frozen, never edit): the SHA-256 pins that were current on the day HF-PAGES-2 shipped (hashes of the
 * web/src/pages/*.astro sources, HF-SAFE-13). Receipts holding one of these were accepted by every registered user
 * today. A receipt holding this exact hash counts as the same as `site:<slug>:1`, so shipping the new scheme does NOT
 * ask current users to accept again. This equivalence applies to material_version 1 ONLY: the first material edit
 * (material_version 2) is not satisfied by a legacy receipt, which is the point.
 */
export const HF_LEGACY_POLICY_HASHES: Record<RegistrationPolicy, string> = {
  terms: "sha256:d67d0b657dc64a8fd7358efe636ce8a4d13912b6e288fb52ff3981ec9fddec63",
  privacy: "sha256:f4ce51d529fafb2e678a58eeaf62a38e33b2259bf70a10f8438ccb6b4f6b58ff",
  disclaimer: "sha256:70ebba45f4cbdb5c01b4cd09a23a55942133ea225dc96e0d85d6ad65bca984bc",
  community: "sha256:09ac69f38be00a8968ced85f66dbc2625ad4d8d0fc5d7b99199db15f622b18e8",
  engagement: "sha256:774b7a6e10ac6f7a9b74b2f2ace336b53aaced6a991137959a43ac4d51923167",
};

export type PolicyPin = { path: string; version: string; materialVersion: number };
export type PolicyPins = Record<RegistrationPolicy, PolicyPin>;

export const policyPinString = (name: RegistrationPolicy, materialVersion: number) => `site:${HF_POLICY_SLUGS[name]}:${materialVersion}`;

export function buildPins(materialVersions: Partial<Record<RegistrationPolicy, number>>): PolicyPins {
  return Object.fromEntries(REGISTRATION_POLICY_NAMES.map((name) => {
    const mv = Number.isInteger(materialVersions[name]) && (materialVersions[name] as number) >= 1 ? (materialVersions[name] as number) : 1;
    return [name, { path: PATHS[name], version: policyPinString(name, mv), materialVersion: mv }];
  })) as PolicyPins;
}

/** Does this stored/posted version string satisfy the current pin of `name`? (see HF_LEGACY_POLICY_HASHES) */
export function receiptSatisfiesPin(name: RegistrationPolicy, receipt: unknown, pins: PolicyPins): boolean {
  if (typeof receipt !== "string") return false;
  const pin = pins[name];
  if (receipt === pin.version) return true;
  return pin.materialVersion === 1 && receipt === HF_LEGACY_POLICY_HASHES[name];
}

/** Which of the five agreements a person still has to accept, given all their receipts (any policy, any version). */
export function pendingPolicyNames(pins: PolicyPins, receipts: { policy: string; document_version: string }[]): RegistrationPolicy[] {
  return REGISTRATION_POLICY_NAMES.filter((name) => !receipts.some((r) => r.policy === name && receiptSatisfiesPin(name, r.document_version, pins)));
}

/**
 * Read posted `acceptedPolicyVersions` and keep only the entries that satisfy the CURRENT pin. A legacy hash is accepted
 * while the policy is still at material version 1, and is stored as the new `site:` pin (what the receipt table holds from now on).
 */
export function currentPolicyAcceptances(raw: unknown, pins: PolicyPins): Partial<Record<RegistrationPolicy, string>> {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return Object.fromEntries(REGISTRATION_POLICY_NAMES
    .filter((name) => receiptSatisfiesPin(name, value[name], pins))
    .map((name) => [name, pins[name].version]));
}

// Short in-worker cache: a material bump reaches every isolate within PIN_TTL_MS. Failure (no column yet, D1 hiccup) keeps the last
// good pins, or material version 1 for everything, which equals the legacy pins, so nobody is asked again by mistake.
const PIN_TTL_MS = 30_000;
let cache: { at: number; pins: PolicyPins } | null = null;
export function resetPolicyPinCache() { cache = null; }

export async function getPolicyPins(env: Env): Promise<PolicyPins> {
  const now = Date.now();
  if (cache && now - cache.at < PIN_TTL_MS) return cache.pins;
  try {
    const slugs = REGISTRATION_POLICY_NAMES.map((n) => HF_POLICY_SLUGS[n]);
    const rs = await env.DB_META.prepare(`SELECT slug,material_version FROM site_pages WHERE slug IN (${slugs.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...slugs).all<{ slug: string; material_version: number }>();
    const bySlug = new Map((rs.results ?? []).map((r) => [r.slug, Number(r.material_version)]));
    const pins = buildPins(Object.fromEntries(REGISTRATION_POLICY_NAMES.map((n) => [n, bySlug.get(HF_POLICY_SLUGS[n])])));
    cache = { at: now, pins };
    return pins;
  } catch {
    if (cache) { cache = { at: now - PIN_TTL_MS + 5_000, pins: cache.pins }; return cache.pins; } // keep last good pins, retry in 5 s
    return buildPins({});
  }
}

/** [HF-POLICY-WITHDRAW-1] One plain line shown in the dashboard re-accept prompt. Update it BEFORE marking an edit material. */
export const HF_POLICY_CHANGE_NOTE = "Calls are now recorded for safety and checked by AI after the call. Nobody listens live. We also added clear strike, appeal and pause rules.";
