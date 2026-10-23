// Exact SHA-256 of each linked web/src/pages/*.astro source at this release.
// When a document changes, update its hash here. Stale acceptance is rejected;
// previously saved receipts retain the document version the person accepted.
export const HF_REGISTRATION_POLICIES = {
  terms: { path: "/terms", version: "sha256:55846d73ea41fb04f14dcbf8466f2758fd3627da9694d5849799ba43a60ef34c" },
  privacy: { path: "/privacy", version: "sha256:371246b15d179f3c5f664b9d447b18bd2efc10a4af519ca610ae7f78ec914a1e" },
  disclaimer: { path: "/disclaimer", version: "sha256:70ebba45f4cbdb5c01b4cd09a23a55942133ea225dc96e0d85d6ad65bca984bc" },
  community: { path: "/community-guidelines", version: "sha256:0d2f0ac5f2e71a36ba4ff0e040316f0521a83e8ea6dfc4546d90537af3c0fb2e" },
  engagement: { path: "/rules-of-engagement", version: "sha256:29131c1ef50b45bf7ae21bc73899c56bc82f3900e8f55efc87749aaffa246572" },
} as const;

export type RegistrationPolicy = keyof typeof HF_REGISTRATION_POLICIES;
export const REGISTRATION_POLICY_NAMES = Object.keys(HF_REGISTRATION_POLICIES) as RegistrationPolicy[];

export function currentPolicyAcceptances(raw: unknown): Partial<Record<RegistrationPolicy, string>> {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return Object.fromEntries(REGISTRATION_POLICY_NAMES
    .filter((name) => value[name] === HF_REGISTRATION_POLICIES[name].version)
    .map((name) => [name, HF_REGISTRATION_POLICIES[name].version]));
}

/** [HF-POLICY-WITHDRAW-1] One plain line shown in the dashboard re-accept prompt. Update it whenever the pins change. */
export const HF_POLICY_CHANGE_NOTE = "We now call payouts \u201cwithdrawals\u201d and send money only to UPI.";
