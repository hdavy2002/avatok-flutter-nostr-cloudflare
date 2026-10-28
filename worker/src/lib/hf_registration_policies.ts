// Exact SHA-256 of each linked web/src/pages/*.astro source at this release.
// When a document changes, update its hash here. Stale acceptance is rejected;
// previously saved receipts retain the document version the person accepted.
export const HF_REGISTRATION_POLICIES = {
  terms: { path: "/terms", version: "sha256:99382949124d5a4522e5748cc7f1babc929b1c4d6ffae01411c7210264121a01" },
  privacy: { path: "/privacy", version: "sha256:f4ce51d529fafb2e678a58eeaf62a38e33b2259bf70a10f8438ccb6b4f6b58ff" },
  disclaimer: { path: "/disclaimer", version: "sha256:70ebba45f4cbdb5c01b4cd09a23a55942133ea225dc96e0d85d6ad65bca984bc" },
  community: { path: "/community-guidelines", version: "sha256:5e40d81a778d433b09edad87b51f46b3a7c4deeb74104ebc4b354b66f56e7494" },
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
