// ── BRAIN_DOMAINS registry — One Brain B0 (SPEC-2026-07-17 §3) ──────────────
//
// The single authority for every brain ingestion domain. Each domain declares:
//   • consent — the consent key checked against `brain_consent` (opt-out model).
//               Several domains intentionally share ONE consent key (calls+missed,
//               msg_meta+msg_content) so one Settings toggle governs a whole area.
//   • label   — the human label the Settings UI renders (generated from here, so a
//               capability can never exist without a toggle, and vice-versa).
//   • default — the opt-out default (all true today).
//   • scope   — DERIVED, never trusted from a caller (§2.1). 'account_private' data
//               may enter the server brain; 'device_private' NEVER leaves the device
//               (server ingestion HARD-REJECTS it) and uses a device-only API.
//
// "Tomorrow's new app = one new row + brainIngest calls." That IS the integration.
// Adding a row here + declaring the consent key is the whole contract.

export type BrainScope = "account_private" | "device_private";

export interface BrainDomainDef {
  readonly consent: string;
  readonly label: string;
  readonly default: boolean;
  readonly scope: BrainScope;
}

export const BRAIN_DOMAINS = {
  contacts:    { consent: "contacts",  label: "Contacts",      default: true, scope: "account_private" },
  calls:       { consent: "calls",     label: "Call history",  default: true, scope: "account_private" },
  missed:      { consent: "calls",     label: "Call history",  default: true, scope: "account_private" },
  voicemail:   { consent: "voicemail", label: "Voicemails",    default: true, scope: "account_private" },
  msg_meta:    { consent: "messages",  label: "Chat activity", default: true, scope: "account_private" }, // metadata ONLY (B-D1)
  msg_content: { consent: "messages",  label: "Chat content",  default: true, scope: "device_private"  }, // device API only — server rejects
  listings:    { consent: "listings",  label: "Marketplace",   default: true, scope: "account_private" },
  wallet:      { consent: "wallet",    label: "Wallet",        default: true, scope: "account_private" },
  files:       { consent: "files",     label: "Files",         default: true, scope: "account_private" },
  // NOT in the spec's §3 table. Added per B0 task instruction: the api.ts profile
  // producer (bio / display name / pronouns) has no natural home among the domains
  // above, so it gets its own row + consent key rather than riding an unblockable
  // fallback. account_private, opt-out ON like the rest. See report/deviations.
  profile:     { consent: "profile",   label: "Profile",       default: true, scope: "account_private" },
  // ── One Brain B2 (SPEC §8-B2) — newly-wired domains. All account_private,
  // opt-out ON, basis: consent (the ordinary consent model — distinct from the
  // future legal-basis `safety` domain in §10, which a later agent owns and is
  // deliberately NOT added here). Each has one brainIngest producer:
  //   identity → id.ts/kyc.ts/liveness*.ts (previously dropped as 'avaid')
  //   calendar → calendar.ts   live → live.ts   verse → verse.ts
  identity:    { consent: "identity",  label: "Identity verification", default: true, scope: "account_private" },
  calendar:    { consent: "calendar",  label: "Calendar",      default: true, scope: "account_private" },
  live:        { consent: "live",      label: "Live sessions", default: true, scope: "account_private" },
  verse:       { consent: "verse",     label: "AvaVerse",      default: true, scope: "account_private" },
} as const satisfies Record<string, BrainDomainDef>;

// The domain union. An unknown domain fails at the TYPE level (callers of
// brainIngest / brainFact cannot pass a string that isn't a registered domain).
export type BrainDomain = keyof typeof BRAIN_DOMAINS;

// The consent-key union, derived from the registry (single source of truth).
export type BrainConsentKey = (typeof BRAIN_DOMAINS)[BrainDomain]["consent"];

/** True iff `d` is a registered brain domain (runtime guard for legacy call sites). */
export function isBrainDomain(d: string): d is BrainDomain {
  return Object.prototype.hasOwnProperty.call(BRAIN_DOMAINS, d);
}

/** The consent key gating a domain (registry-resolved). */
export function consentKeyFor(domain: BrainDomain): BrainConsentKey {
  return BRAIN_DOMAINS[domain].consent;
}

/** The derived scope for a domain — the ONLY authority (§2.1). */
export function scopeFor(domain: BrainDomain): BrainScope {
  return BRAIN_DOMAINS[domain].scope;
}

/** Registry as the wire shape for GET /api/brain/domains (contract §3). */
export function brainDomainList(): Array<{
  key: BrainDomain;
  consentKey: BrainConsentKey;
  label: string;
  default: boolean;
  scope: BrainScope;
}> {
  return (Object.keys(BRAIN_DOMAINS) as BrainDomain[]).map((key) => {
    const d = BRAIN_DOMAINS[key];
    return { key, consentKey: d.consent, label: d.label, default: d.default, scope: d.scope };
  });
}
