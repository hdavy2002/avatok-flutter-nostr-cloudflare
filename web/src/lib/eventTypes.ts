// [SAATHUM-EVENT-TYPES 2026-09-27] OWNER DECISION: one event form for several kinds of
// event. The admin picks the TYPE first; every customer-facing word, badge, feature tick,
// checkout step and email follows from it. This file is the single source of that copy on
// the web (the worker mirrors the rules in worker/src/lib/event_types.ts — keep in step).
//
// NOTE FOR AI:
//  - Stored as listings.attrs.event_type. Missing/unknown → 'havan' (every event made
//    before 2026-09-27 was a havan).
//  - `ritual: true` (havan, puja) = sankalp, chadhava and prasad courier exist.
//    Satsang, sermon and meditation NEVER offer sankalp, chadhava or prasad — the owner
//    was explicit. Their checkout is: sign in → (name only) → optional offering → pay.
//  - Never write the word "YouTube" on the customer side (owner rule). Say
//    "Live streaming event".
//  - No guaranteed outcomes, no fear selling. Brand is "Saa Thum".

export type EventType = 'havan' | 'puja' | 'satsang' | 'sermon' | 'meditation';

export const EVENT_TYPES: EventType[] = ['havan', 'puja', 'satsang', 'sermon', 'meditation'];

export interface EventTypeCopy {
  type: EventType;
  /** Badge on the photo, e.g. "HAVAN". */
  badge: string;
  /** Title-case name, e.g. "Havan". */
  label: string;
  /** Lower-case noun used in sentences, e.g. "havan", "meditation session". */
  noun: string;
  /** Badge colours (background, text). */
  color: { bg: string; fg: string };
  /** Havan, puja: sankalp + chadhava + prasad. */
  ritual: boolean;
  /** "Performed by" / "Led by" / "Delivered by" / "Guided by". */
  performerLabel: string;
  /** Admin form label for the person, e.g. "Priest's name". */
  performerField: string;
  /** Fallback when no name is set, e.g. "temple priests". */
  performerFallback: string;
  /** Countdown label on the photo. */
  startsIn: string;
  /** Main booking button. */
  cta: string;
  /** Short card button. */
  ctaShort: string;
  /** "Read benefits" / "Read more". */
  readMore: string;
  /** "About this havan" kicker. */
  aboutKicker: string;
  /** Benefits kicker. */
  benefitsKicker: string;
  /** Checkout offering label (dakshina / offering). */
  offeringLabel: string;
  /** Line under the card buttons. */
  footer: (performer: string | null) => string;
  /** The three "How it works" steps. */
  steps: { title: string; body: string; sticker: string }[];
  /** Checkout "done" headline. */
  doneTitle: string;
}

const RITUAL_STEPS = (noun: string) => [
  { title: 'Book with your sankalp', body: 'Your name, gotra and wish are read out by the priest.', sticker: 'sankalp-thali' },
  { title: 'The priest performs it', body: `Your ${noun} is performed at the altar at the scheduled time.`, sticker: 'whatsapp-diya' },
  { title: 'Get the video and prasad', body: 'We email you the video when it finishes. Prasad ships the same day.', sticker: 'prasad-box' },
];

const TALK_STEPS = (noun: string) => [
  { title: 'Reserve your seat', body: `One booking per family — join the ${noun} from anywhere.`, sticker: 'sankalp-thali' },
  { title: 'It happens on schedule', body: `The ${noun} takes place at the scheduled time.`, sticker: 'whatsapp-diya' },
  { title: 'Get the video', body: 'We email you the video when it finishes. Download it anytime from My events.', sticker: 'havan-kund' },
];

export const EVENT_TYPE_COPY: Record<EventType, EventTypeCopy> = {
  havan: {
    type: 'havan', badge: 'Havan', label: 'Havan', noun: 'havan', color: { bg: '#d9531e', fg: '#fff' }, ritual: true,
    performerLabel: 'Performed by', performerField: "Priest's name", performerFallback: 'temple priests',
    startsIn: 'Havan starts in', cta: 'Book with my sankalp', ctaShort: 'Book now', readMore: 'Read benefits',
    aboutKicker: 'About this havan', benefitsKicker: 'What devotees traditionally seek', offeringLabel: 'Offering for the priest',
    footer: (p) => `Performed by ${p || 'temple priests'} · Free cancellation 24 hrs before`,
    steps: RITUAL_STEPS('havan'), doneTitle: 'Your sankalp is booked 🙏',
  },
  puja: {
    type: 'puja', badge: 'Puja', label: 'Puja', noun: 'puja', color: { bg: '#b3261e', fg: '#fff' }, ritual: true,
    performerLabel: 'Performed by', performerField: "Priest's name", performerFallback: 'temple priests',
    startsIn: 'Puja starts in', cta: 'Book with my sankalp', ctaShort: 'Book now', readMore: 'Read benefits',
    aboutKicker: 'About this puja', benefitsKicker: 'What devotees traditionally seek', offeringLabel: 'Offering for the priest',
    footer: (p) => `Performed by ${p || 'temple priests'} · Free cancellation 24 hrs before`,
    steps: RITUAL_STEPS('puja'), doneTitle: 'Your sankalp is booked 🙏',
  },
  satsang: {
    type: 'satsang', badge: 'Satsang', label: 'Satsang', noun: 'satsang', color: { bg: '#1f6f6a', fg: '#fff' }, ritual: false,
    performerLabel: 'Led by', performerField: "Speaker's name", performerFallback: 'our speaker',
    startsIn: 'Satsang starts in', cta: 'Reserve my seat', ctaShort: 'Reserve', readMore: 'Read more',
    aboutKicker: 'About this satsang', benefitsKicker: 'What you will take away', offeringLabel: 'Offering (optional)',
    footer: (p) => `Led by ${p || 'our speaker'} · Free cancellation 24 hrs before`,
    steps: TALK_STEPS('satsang'), doneTitle: 'Your seat is reserved 🙏',
  },
  sermon: {
    type: 'sermon', badge: 'Sermon', label: 'Sermon', noun: 'sermon', color: { bg: '#3b3f8f', fg: '#fff' }, ritual: false,
    performerLabel: 'Delivered by', performerField: "Speaker's name", performerFallback: 'our speaker',
    startsIn: 'Sermon starts in', cta: 'Reserve my seat', ctaShort: 'Reserve', readMore: 'Read more',
    aboutKicker: 'About this sermon', benefitsKicker: 'What you will take away', offeringLabel: 'Offering (optional)',
    footer: (p) => `Delivered by ${p || 'our speaker'} · Free cancellation 24 hrs before`,
    steps: TALK_STEPS('sermon'), doneTitle: 'Your seat is reserved 🙏',
  },
  meditation: {
    type: 'meditation', badge: 'Meditation', label: 'Meditation', noun: 'meditation session', color: { bg: '#6b4fa0', fg: '#fff' }, ritual: false,
    performerLabel: 'Guided by', performerField: "Guide's name", performerFallback: 'our guide',
    startsIn: 'Session starts in', cta: 'Join the session', ctaShort: 'Join', readMore: 'Read more',
    aboutKicker: 'About this session', benefitsKicker: 'What people practise it for', offeringLabel: 'Offering (optional)',
    footer: (p) => `Guided by ${p || 'our guide'} · Free cancellation 24 hrs before`,
    steps: TALK_STEPS('meditation session'), doneTitle: 'You are in 🙏',
  },
};

export function eventTypeOf(attrs: Record<string, unknown> | null | undefined): EventType {
  const v = attrs?.event_type;
  return typeof v === 'string' && (EVENT_TYPES as string[]).includes(v) ? (v as EventType) : 'havan';
}

export function copyFor(attrs: Record<string, unknown> | null | undefined): EventTypeCopy {
  return EVENT_TYPE_COPY[eventTypeOf(attrs)];
}

/** Social-proof numbers the admin can set (owner decision 2026-09-27). Real + admin extra. */
export function socialProof(
  attrs: Record<string, unknown> | null | undefined,
  real: { booked: number; ratingAvg: number | null; ratingCount: number },
): { booked: number; rating: number | null; reviews: number } {
  const n = (k: string) => { const v = Number(attrs?.[k]); return Number.isFinite(v) && v > 0 ? v : 0; };
  const reviews = Math.round(real.ratingCount + n('review_count_boost'));
  const set = n('rating_display');
  const rating = set >= 1 && set <= 5 ? set : (real.ratingCount > 0 && real.ratingAvg ? real.ratingAvg : null);
  return { booked: Math.round(real.booked + n('booked_boost')), rating: reviews > 0 ? rating : null, reviews: rating ? reviews : 0 };
}
