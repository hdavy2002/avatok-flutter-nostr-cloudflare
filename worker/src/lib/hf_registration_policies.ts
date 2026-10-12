// Exact SHA-256 of each linked web/src/pages/*.astro source at this release.
// When a document changes, update its hash here. Stale acceptance is rejected;
// previously saved receipts retain the document version the person accepted.
export const HF_REGISTRATION_POLICIES = {
  terms: { path: "/terms", version: "sha256:cba0773e779a0a0e85614b27dc1487885def947a2feb167559539664720f190d" },
  privacy: { path: "/privacy", version: "sha256:f801ffac2e86e97ec8fb72832a286f9cc439007c528bf8ba71c5bba0c8471478" },
  disclaimer: { path: "/disclaimer", version: "sha256:cddc8afa11b06f89b01f737ca49230f3b417f891c65b6a325761be2781497432" },
  community: { path: "/community-guidelines", version: "sha256:174a2a933ecf0ae249c7e3a241f6aa188dbf33a62c185b5dd2cd4bd747ee2b66" },
  engagement: { path: "/rules-of-engagement", version: "sha256:ed417239cf193a4bf3e442c7ee22fcc47446a96bd61c6d267b102aad04c82eff" },
} as const;

export type RegistrationPolicy = keyof typeof HF_REGISTRATION_POLICIES;
export const REGISTRATION_POLICY_NAMES = Object.keys(HF_REGISTRATION_POLICIES) as RegistrationPolicy[];

export function currentPolicyAcceptances(raw: unknown): Partial<Record<RegistrationPolicy, string>> {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return Object.fromEntries(REGISTRATION_POLICY_NAMES
    .filter((name) => value[name] === HF_REGISTRATION_POLICIES[name].version)
    .map((name) => [name, HF_REGISTRATION_POLICIES[name].version]));
}
