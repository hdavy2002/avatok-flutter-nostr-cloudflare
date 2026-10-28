// Exact SHA-256 of each linked web/src/pages/*.astro source at this release.
// When a document changes, update its hash here. Stale acceptance is rejected;
// previously saved receipts retain the document version the person accepted.
export const HF_REGISTRATION_POLICIES = {
  terms: { path: "/terms", version: "sha256:d67d0b657dc64a8fd7358efe636ce8a4d13912b6e288fb52ff3981ec9fddec63" },
  privacy: { path: "/privacy", version: "sha256:f4ce51d529fafb2e678a58eeaf62a38e33b2259bf70a10f8438ccb6b4f6b58ff" },
  disclaimer: { path: "/disclaimer", version: "sha256:70ebba45f4cbdb5c01b4cd09a23a55942133ea225dc96e0d85d6ad65bca984bc" },
  community: { path: "/community-guidelines", version: "sha256:09ac69f38be00a8968ced85f66dbc2625ad4d8d0fc5d7b99199db15f622b18e8" },
  engagement: { path: "/rules-of-engagement", version: "sha256:774b7a6e10ac6f7a9b74b2f2ace336b53aaced6a991137959a43ac4d51923167" },
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
export const HF_POLICY_CHANGE_NOTE = "Calls are now recorded for safety and checked by AI after the call. Nobody listens live. We also added clear strike, appeal and pause rules.";
