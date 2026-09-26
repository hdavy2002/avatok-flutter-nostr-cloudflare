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
