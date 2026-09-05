// [ADMIN-PLAIN-1 2026-09-05] Plain English for the review queue.
//
// The workbench was showing a non-technical reviewer raw database values:
// `pending_review`, `always_on`, `live_event`, `regenerate_poster`,
// `user_3AUQQADIDHJFTJTTKLD0DTKM8MB`, and — after an admin edit — a JSON diff
// blob rendered as a paragraph. The owner's words: "I see lots of code ... for
// tech people its cool, but not for staff."
//
// One module, so a value is worded the same in the queue rail, the submission
// panel and the history timeline. Every lookup falls back to a HUMANISED form of
// the raw value rather than to the raw value itself — a code we forgot to add
// here should read as "Always on", not as `always_on`, and certainly not as
// blank. Unknown is not the same as absent.

/** `always_on` -> `Always on`. The fallback for everything below. */
export function humanise(raw: unknown): string {
  const v = String(raw ?? '').trim();
  if (!v) return '—';
  const words = v.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const STATUS: Record<string, string> = {
  draft: 'Draft',
  pending_review: 'Waiting for review',
  approved: 'Approved',
  published: 'Live on the site',
  live: 'Streaming now',
  rejected: 'Changes requested',
  cancelled: 'Cancelled',
  completed: 'Finished',
};

const KIND: Record<string, string> = {
  live_event: 'Live event',
  consult: '1:1 session',
  ai_agent: 'AI agent',
  sell: 'For sale',
  buy: 'Wanted',
  social: 'Social',
};

const SECTION: Record<string, string> = {
  live_streaming: 'India goes live',
  live_friends: 'Find your people',
  adda_rooms: 'Adda rooms',
  consulting: 'Book their time',
  astro_tarot: 'Astrology & tarot',
  glow_up: 'Style & glow-up',
  ai_voice_agents: 'Voice agents (retired)',
  other: 'Other',
};

const SCHEDULE: Record<string, string> = {
  fixed_date: 'One fixed date',
  recurring: 'Repeats weekly',
  on_request: 'On request',
  always_on: 'No fixed time',
};

const MEDIA_MODE: Record<string, string> = {
  audio_video: 'Audio and video',
  audio_only: 'Audio only',
};

/** What an action DID, in the past tense, as a sentence rather than a symbol. */
const ACTION: Record<string, string> = {
  submit_for_review: 'Creator sent it for review',
  approve_listing: 'Approved the listing',
  reapprove_content: 'Re-approved the current content',
  reject_listing: 'Asked the creator for changes',
  generate_poster: 'Generated the poster',
  regenerate_poster: 'Generated a new poster',
  approve_poster: 'Approved the poster',
  reject_poster: 'Rejected the poster',
  publish: 'Published it',
  admin_edit: 'Edited the listing',
};

const POSTER_STATUS: Record<string, string> = {
  generating: 'Being made',
  draft: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
  failed: 'Failed',
};

/** Field names as a reviewer would say them, for the admin-edit diff. */
const FIELD: Record<string, string> = {
  title: 'Title',
  blurb: 'One-liner',
  description: 'Description',
  category: 'Category',
  price: 'Price',
  currency_display: 'Currency',
  free_entry: 'Free entry',
  starts_at: 'Start time',
  duration_min: 'Length',
  schedule_mode: 'Schedule',
  recurrence_days: 'Repeat days',
  recurrence_time: 'Repeat time',
  timezone: 'Timezone',
  capacity: 'Capacity',
  max_per_booking: 'Max per booking',
  response_time_min: 'Reply time',
  location: 'Location',
  country: 'Country',
  video_url: 'Video',
  spoken_lang: 'Languages',
  adults_only: 'Adults only',
  credential: 'Credential',
  media_mode: 'Audio/video',
  cover_media: 'Photos',
};

const lookup = (map: Record<string, string>, raw: unknown): string =>
  map[String(raw ?? '')] ?? humanise(raw);

export const statusLabel = (v: unknown) => lookup(STATUS, v);
export const kindLabel = (v: unknown) => lookup(KIND, v);
export const sectionLabel = (v: unknown) => lookup(SECTION, v);
export const scheduleLabel = (v: unknown) => lookup(SCHEDULE, v);
export const mediaModeLabel = (v: unknown) => lookup(MEDIA_MODE, v);
export const actionLabel = (v: unknown) => lookup(ACTION, v);
export const posterStatusLabel = (v: unknown) => lookup(POSTER_STATUS, v);
export const fieldLabel = (v: unknown) => lookup(FIELD, v);

/** A person, by name where we know it. Falls back to a SHORT id — a reviewer
 *  scanning a timeline can tell two truncated ids apart, which is all the raw
 *  40-character uid was ever achieving. */
export function personLabel(
  uid: unknown,
  names?: Record<string, string | null | undefined> | null,
): string {
  const id = String(uid ?? '').trim();
  if (!id) return 'the system';
  const name = names?.[id];
  if (name) return name;
  return `Unknown admin (…${id.slice(-6)})`;
}

/** Values inside the admin-edit diff, formatted per field so a reviewer reads
 *  "6 Sept 2026, 02:42" rather than 1788815520000. */
export function fieldValueLabel(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return 'empty';
  if (field === 'starts_at') {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? new Date(n).toLocaleString() : String(v);
  }
  if (field === 'duration_min' || field === 'response_time_min') return `${v} min`;
  if (field === 'price') return `₹${v}`;
  if (field === 'free_entry' || field === 'adults_only') return Number(v) === 1 ? 'yes' : 'no';
  if (field === 'schedule_mode') return scheduleLabel(v);
  if (field === 'media_mode') return mediaModeLabel(v);
  const s = String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
