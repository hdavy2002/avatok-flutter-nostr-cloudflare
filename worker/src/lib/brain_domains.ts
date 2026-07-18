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

// §10.1 — the lawful basis for processing a domain. 'consent' → a user-movable
// Settings toggle (the ordinary opt-out model). 'legal' → legitimate interest /
// legal obligation: NOT a toggle, rendered as a disclosure (a control the user
// cannot move would be "a consent UI that lies"). Only 'legal' domains may carry
// consent:null (there is no consent key to gate on) and are non-deletable by their
// subject (§10.2).
export type BrainBasis = "consent" | "legal";

// Consent-based domain: user-toggleable, gated by a consent key, deletion-contract
// (§5.1) deletable unless a row explicitly opts out.
interface BrainDomainConsent {
  readonly basis: "consent";
  readonly consent: string;
  readonly label: string;
  readonly default: boolean;
  readonly scope: BrainScope;
  readonly deletable?: boolean; // default true (follows the §5.1 deletion contract)
  readonly acl?: string;
}

// Legal-basis domain (§10.1/§10.2): consent:null (no toggle — a disclosure only),
// deletable:false (the §5.1 deletion job skips it — §10.2), ACL'd to a module
// boundary (§10.3). The `safety` store is the sole instance.
interface BrainDomainLegal {
  readonly basis: "legal";
  readonly consent: null;
  readonly deletable: false;
  readonly acl: "guardian";
  readonly label: string;
  readonly default: boolean;
  readonly scope: BrainScope;
}

export type BrainDomainDef = BrainDomainConsent | BrainDomainLegal;

export const BRAIN_DOMAINS = {
  contacts:    { basis: "consent", consent: "contacts",  label: "Contacts",      default: true, scope: "account_private" },
  calls:       { basis: "consent", consent: "calls",     label: "Call history",  default: true, scope: "account_private" },
  missed:      { basis: "consent", consent: "calls",     label: "Call history",  default: true, scope: "account_private" },
  voicemail:   { basis: "consent", consent: "voicemail", label: "Voicemails",    default: true, scope: "account_private" },
  msg_meta:    { basis: "consent", consent: "messages",  label: "Chat activity", default: true, scope: "account_private" }, // metadata ONLY (B-D1)
  msg_content: { basis: "consent", consent: "messages",  label: "Chat content",  default: true, scope: "device_private"  }, // device API only — server rejects
  listings:    { basis: "consent", consent: "listings",  label: "Marketplace",   default: true, scope: "account_private" },
  wallet:      { basis: "consent", consent: "wallet",    label: "Wallet",        default: true, scope: "account_private" },
  files:       { basis: "consent", consent: "files",     label: "Files",         default: true, scope: "account_private" },
  // NOT in the spec's §3 table. Added per B0 task instruction: the api.ts profile
  // producer (bio / display name / pronouns) has no natural home among the domains
  // above, so it gets its own row + consent key rather than riding an unblockable
  // fallback. account_private, opt-out ON like the rest. See report/deviations.
  profile:     { basis: "consent", consent: "profile",   label: "Profile",       default: true, scope: "account_private" },
  // ── One Brain B2 (SPEC §8-B2) — newly-wired domains. All account_private,
  // opt-out ON, basis: consent (the ordinary consent model). Each has one
  // brainIngest producer:
  //   identity → id.ts/kyc.ts/liveness*.ts (previously dropped as 'avaid')
  //   calendar → calendar.ts   live → live.ts   verse → verse.ts
  identity:    { basis: "consent", consent: "identity",  label: "Identity verification", default: true, scope: "account_private" },
  calendar:    { basis: "consent", consent: "calendar",  label: "Calendar",      default: true, scope: "account_private" },
  live:        { basis: "consent", consent: "live",      label: "Live sessions", default: true, scope: "account_private" },
  verse:       { basis: "consent", consent: "verse",     label: "AvaVerse",      default: true, scope: "account_private" },
  // ── §10 Guardian (SPEC-2026-07-17 §10.1-10.3) — the SAFETY store ────────────
  // basis:'legal' (legitimate interest / legal obligation), NOT consent: it is a
  // DISCLOSURE in Settings, never a toggle (§10.1). consent:null (nothing to gate).
  // deletable:false — the §5.1 deletion job SKIPS it so "delete my AvaBrain data"
  // cannot launder a grooming/enforcement record (§10.2). acl:'guardian' — reachable
  // only via guardianContext() from lib/guardian/, never brainRecall (§10.3). It is
  // NOT per-user memory: a separate store (guardian_events), same governance plane.
  // Never routed through brainIngest/Q_BRAIN — lib/guardian writes it directly.
  safety:      { basis: "legal",   consent: null, deletable: false, acl: "guardian",
                 scope: "account_private", label: "Safety records", default: true },
} as const satisfies Record<string, BrainDomainDef>;

// The domain union. An unknown domain fails at the TYPE level (callers of
// brainIngest / brainFact cannot pass a string that isn't a registered domain).
export type BrainDomain = keyof typeof BRAIN_DOMAINS;

// The consent-key union, derived from the registry (single source of truth).
// NonNullable strips the `null` contributed by legal-basis domains (§10.1) so the
// union stays a set of real capability strings that consentAllows() can bind.
export type BrainConsentKey = NonNullable<(typeof BRAIN_DOMAINS)[BrainDomain]["consent"]>;

/** True iff `d` is a registered brain domain (runtime guard for legacy call sites). */
export function isBrainDomain(d: string): d is BrainDomain {
  return Object.prototype.hasOwnProperty.call(BRAIN_DOMAINS, d);
}

/** The consent key gating a domain (registry-resolved). null for legal-basis
 *  domains (§10.1) — they have no consent to gate on and are never ingested via
 *  the public brainIngest lane. */
export function consentKeyFor(domain: BrainDomain): BrainConsentKey | null {
  return BRAIN_DOMAINS[domain].consent;
}

/** The lawful basis for a domain (§10.1) — 'consent' (toggle) or 'legal' (disclosure). */
export function basisFor(domain: BrainDomain): BrainBasis {
  return BRAIN_DOMAINS[domain].basis;
}

/** Whether a domain's data is deletable by its subject via the §5.1 contract.
 *  Legal-basis domains are never deletable (§10.2); consent domains default true. */
export function isDeletable(domain: BrainDomain): boolean {
  const d = BRAIN_DOMAINS[domain];
  return d.basis === "legal" ? false : ((d as BrainDomainDef).deletable ?? true);
}

/** The derived scope for a domain — the ONLY authority (§2.1). */
export function scopeFor(domain: BrainDomain): BrainScope {
  return BRAIN_DOMAINS[domain].scope;
}

/** Registry as the wire shape for GET /api/brain/domains (contract §3 + §10.1).
 *  `basis` and `deletable` let the client render legal-basis rows as a disclosure
 *  (not a switch) and hide them from the delete-my-data surface. */
export function brainDomainList(): Array<{
  key: BrainDomain;
  consentKey: BrainConsentKey | null;
  basis: BrainBasis;
  deletable: boolean;
  label: string;
  default: boolean;
  scope: BrainScope;
}> {
  return (Object.keys(BRAIN_DOMAINS) as BrainDomain[]).map((key) => {
    const d = BRAIN_DOMAINS[key];
    return {
      key,
      consentKey: d.consent,
      basis: d.basis,
      deletable: d.basis === "legal" ? false : ((d as BrainDomainDef).deletable ?? true),
      label: d.label,
      default: d.default,
      scope: d.scope,
    };
  });
}
