/* [LIST-WIZ-1] The 8-step listing wizard's single draft object.
 *
 * Field names mirror the worker's wire contract 1:1 wherever a name exists
 * there (see worker/src/routes/listings.ts: normFields, listingContentFieldsError,
 * contentAttrsError, commercialPolicyError, EDITABLE) so serialize.ts never has to
 * rename anything going out — it just picks which keys to send for a given step.
 *
 * Spec: Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md §A1 item 4, §C.1, §C.2, §F.
 */

import { normalizeTimezone } from './wizardLogic';

export type Kind = 'live_event' | 'consult' | 'ai_agent';
export type ScheduleMode = 'fixed_date' | 'recurring' | 'on_request' | 'always_on';

export interface HowItWorksStep { label: string; body: string }
export interface HouseRule { heading: string; body: string }
export interface Qa { q: string; a: string }
export interface SampleChatLine { who: string; line: string }
export interface JoinRequirements {
  mic?: boolean;
  cam?: boolean;
  listen_only?: boolean;
  replay_days?: number;
  recording?: boolean;
}
export interface DraftSlot {
  id?: string; // present once saved server-side
  starts_at: number;
  duration_min: number;
  label: string;
  capacity: number;
}
export interface Cover { type: string; url: string }

/** Everything the wizard collects, across all 8 steps. */
export interface ListingDraft {
  id: string | null;
  status?: string;

  // Step 1 — Type
  kind: Kind;
  free_entry: boolean;
  content_free_cap_tokens: string;
  schedule_mode: ScheduleMode;

  // Step 2 — Pitch
  title: string;
  blurb: string;
  description: string;
  category: string;
  vibe_tags: string[];
  spoken_lang: string[];

  // Step 3 — Money
  price: string;
  billing_unit: string;
  early_bird_pct: string;
  promo_code: string;

  // Step 4 — Time
  timezone: string;
  starts_at: string;        // datetime-local string
  duration_min: number;
  recurrence_days: number[];
  recurrence_time: string;
  slots: DraftSlot[];
  response_time_min: string;
  max_per_booking: number;
  capacity: number; // live events: total seats, 0 = unlimited

  // Step 5 — How it works
  content_how_it_works: HowItWorksStep[];

  // Step 6 — House rules & details
  content_house_rules_intro: string;
  content_house_rules: HouseRule[];
  content_what_you_get: string[];
  content_who_for: string[];
  content_not_for: string[];
  content_faq: Qa[];
  join_requirements: JoinRequirements;
  content_join_lead_minutes: number;
  // consult only
  content_sample_qa: Qa[];
  credential: string;
  commercial_preparation_instructions: string;
  // ai_agent only
  content_sample_chat: SampleChatLine[];
  content_can_do: string[];
  content_cant_do: string[];

  // Step 7 — Photos & policy
  cover_media: Cover[];
  video_url: string;
  location: string;
  adults_only: boolean;
  commercial_refund_window_hours: number;           // live_event
  commercial_cancellation_window_hours: number;      // consult
  commercial_reschedule_allowed: boolean;            // consult
  commercial_booking_notice_hours: number;           // consult

  // [POSTER-FIRST-1 2026-09-05] Read-only mirror of the server's `attrs.poster`.
  // The creator never edits this and it is NEVER sent back in bodyForSave —
  // `poster` is in the worker's RESERVED_ATTRS_KEYS (listings.ts:238), so a
  // client that posted one would have it rejected. It rides on the draft purely
  // so step 8 can show the real poster instead of a mock card.
  poster: PosterMirror | null;

  // bookkeeping
  defaultsAppliedFor: string | null; // flavour key the prefill was applied for, so we don't clobber edits
}

export type PosterMirror = {
  status?: 'generating' | 'draft' | 'approved' | 'rejected' | 'failed';
  url?: string;
  /** "overlay" means the artwork is deliberately textless and the CLIENT draws
   *  the title and tagline — see worker/src/lib/listing_poster.ts. */
  lettering?: 'baked' | 'overlay';
  copy?: { title?: string; tagline?: string };
  variants?: Partial<Record<'portrait' | 'tablet' | 'wide', { url: string }>>;
  error?: string;
};

export const STEP_LABELS = [
  'Type', 'Pitch', 'Money', 'Time', 'How it works', 'House rules', 'Photos & policy', 'Preview & publish',
] as const;

export type StepIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export function emptyDraft(initial?: Partial<ListingDraft>): ListingDraft {
  return {
    id: null,
    kind: 'live_event',
    free_entry: false,
    content_free_cap_tokens: '',
    schedule_mode: 'fixed_date',
    title: '',
    blurb: '',
    description: '',
    category: '',
    vibe_tags: [],
    spoken_lang: [],
    price: '',
    billing_unit: 'session',
    early_bird_pct: '',
    promo_code: '',
    timezone: normalizeTimezone(typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'Asia/Kolkata'),
    starts_at: '',
    duration_min: 60,
    recurrence_days: [],
    recurrence_time: '18:00',
    slots: [],
    response_time_min: '',
    max_per_booking: 4,
    capacity: 0,
    content_how_it_works: [],
    content_house_rules_intro: '',
    content_house_rules: [],
    content_what_you_get: [],
    content_who_for: [],
    content_not_for: [],
    content_faq: [],
    join_requirements: {},
    content_join_lead_minutes: 5,
    content_sample_qa: [],
    credential: '',
    commercial_preparation_instructions: '',
    content_sample_chat: [],
    content_can_do: [],
    content_cant_do: [],
    cover_media: [],
    video_url: '',
    location: '',
    adults_only: false,
    commercial_refund_window_hours: 24,
    commercial_cancellation_window_hours: 24,
    commercial_reschedule_allowed: true,
    commercial_booking_notice_hours: 6,
    poster: null,
    defaultsAppliedFor: null,
    ...initial,
  };
}
