// [SAATHUM-EVENT-TYPES 2026-09-27] Worker mirror of web/src/lib/eventTypes.ts (keep in
// step). listings.attrs.event_type drives what a checkout may contain and the email copy.
// Havan/puja are rituals: sankalp, chadhava and prasad courier exist. Satsang, sermon and
// meditation NEVER take chadhava or prasad and need no sankalp (owner decision).
export type EventType = "havan" | "puja" | "satsang" | "sermon" | "meditation";
export const EVENT_TYPES: readonly EventType[] = ["havan", "puja", "satsang", "sermon", "meditation"];

const COPY: Record<EventType, { label: string; noun: string; ritual: boolean; performerLabel: string }> = {
  havan: { label: "Havan", noun: "havan", ritual: true, performerLabel: "Performed by" },
  puja: { label: "Puja", noun: "puja", ritual: true, performerLabel: "Performed by" },
  satsang: { label: "Satsang", noun: "satsang", ritual: false, performerLabel: "Led by" },
  sermon: { label: "Sermon", noun: "sermon", ritual: false, performerLabel: "Delivered by" },
  meditation: { label: "Meditation", noun: "meditation session", ritual: false, performerLabel: "Guided by" },
};

export function eventTypeOf(attrs: Record<string, unknown> | null | undefined): EventType {
  const v = attrs?.event_type;
  return typeof v === "string" && (EVENT_TYPES as readonly string[]).includes(v) ? (v as EventType) : "havan";
}
export function eventTypeCopy(t: EventType) { return COPY[t]; }
export function isRitual(t: EventType): boolean { return COPY[t].ritual; }

// ---------------------------------------------------------------------------
// [SAATHUM-SHARED-SANKALP-1 2026-09-30] OWNER DECISION: public (shared) havans and
// pujas no longer take a personal sankalp. The admin picks one or more ready-made
// COLLECTIVE sankalps on the listing; the pujari recites those for everyone and the
// customer gives only a name (for the receipt; it is NOT read out). A personal
// sankalp (name, gotra, family names, wish) is taken ONLY by a ritual that is booked
// for one family — today the legacy "private" (1 seat) listing, and the upcoming
// recorded "Sankalp Puja / Sankalp Havan" format (attrs.format === 'sankalp').
// Web mirror: web/src/lib/eventTypes.ts — keep the two in step.
// ---------------------------------------------------------------------------
export const COLLECTIVE_SANKALPS: Record<string, string> = {
  education: "Education & studies",
  good_health: "Good health",
  family_health: "Health of the family",
  departed: "Peace for departed souls",
  new_beginnings: "New beginnings",
  career: "Career & livelihood",
  prosperity: "Prosperity",
  peace: "Peace & protection",
  harmony: "Harmony at home",
};

/** Valid collective-sankalp keys stored on attrs.collective_sankalp (order kept, deduped). */
export function collectiveSankalpsOf(attrs: Record<string, unknown> | null | undefined): string[] {
  const raw = attrs?.collective_sankalp;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const k of raw) if (typeof k === "string" && COLLECTIVE_SANKALPS[k] && !out.includes(k)) out.push(k);
  return out;
}

/** True only when checkout must collect a PERSONAL sankalp (gotra, family, wish). */
export function takesPersonalSankalp(attrs: Record<string, unknown> | null | undefined): boolean {
  if (!isRitual(eventTypeOf(attrs))) return false;
  return attrs?.visibility === "private" || attrs?.format === "sankalp";
}
