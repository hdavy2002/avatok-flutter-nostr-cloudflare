/* [LIST-WIZ-1] Serialization + client-side validation for the listing wizard.
 *
 * Every check here mirrors a server check exactly (same limits, same shape) so a
 * creator never hits a 4xx from the wizard's own "Next" button — see
 * worker/src/routes/listings.ts: normFields, listingContentFieldsError,
 * contentAttrsError, commercialPolicyError. The server remains the authority;
 * this only spares a round trip and gives the creator the message before they
 * submit. When the server still 400/422s (a race, a stale client, a bug here),
 * the wizard shows ITS message and highlights ITS field — see ListingWizard.tsx.
 */
import type { ListingDraft, StepIndex } from './types';

export const VIBE_TAGS = ['safe_space', 'cam_optional', 'listener_first', 'savage', 'beginner_ok', 'queer_friendly', 'women_only'] as const;
export const BILLING_UNITS = ['session', 'minute', '10min', 'chat', 'night', 'game'] as const;
export const SCHEDULE_MODES = ['fixed_date', 'recurring', 'on_request', 'always_on'] as const;
export const REFUND_WINDOWS = [0, 12, 24, 48] as const;
export const BOOKING_NOTICE_HOURS = [1, 2, 6, 24] as const;

export function localToEpoch(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function epochToLocal(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/* A browser's `Intl.DateTimeFormat().resolvedOptions().timeZone` can still
 * return the old IANA link name 'Asia/Calcutta' (some older Android/WebView
 * builds do). It's a valid alias — `isValidTimezone` accepts it — but it is
 * not one of the wizard's TZ_OPTIONS, so a creator with that browser setting
 * would silently land in the free-text "Other…" box instead of the "India"
 * option every IST creator should get by default. Normalise on the way in:
 * emptyDraft() (fresh listing) and draftFromListing() (editing one saved
 * before this existed). */
const TZ_ALIASES: Record<string, string> = { 'Asia/Calcutta': 'Asia/Kolkata' };
export function normalizeTimezone(tz: string): string {
  return TZ_ALIASES[tz] ?? tz;
}

/** Build the ONE `attrs` JSON object from the draft. This is sent WHOLESALE on
 *  every save that touches any content_ / commercial_ / join_requirements field —
 *  the server column is a single JSON blob, not a per-key merge, so a partial
 *  attrs write would silently erase everything collected in an earlier step. */
export function buildAttrs(d: ListingDraft): Record<string, unknown> {
  const a: Record<string, unknown> = {};
  if (d.content_how_it_works.length >= 2) a.content_how_it_works = d.content_how_it_works.slice(0, 5);
  if (d.content_house_rules.length >= 3) a.content_house_rules = d.content_house_rules.slice(0, 8);
  if (d.content_house_rules_intro.trim()) a.content_house_rules_intro = d.content_house_rules_intro.slice(0, 280);
  if (d.content_join_lead_minutes != null) a.content_join_lead_minutes = d.content_join_lead_minutes;
  if (d.free_entry) {
    const n = Math.trunc(Number(d.content_free_cap_tokens));
    if (Number.isInteger(n) && n > 0) a.content_free_cap_tokens = n;
  }
  if (d.content_what_you_get.length >= 3) a.content_what_you_get = d.content_what_you_get.slice(0, 5);
  if (d.content_who_for.length) a.content_who_for = d.content_who_for.slice(0, 3);
  if (d.content_not_for.length) a.content_not_for = d.content_not_for.slice(0, 3);
  if (d.content_faq.length >= 3) a.content_faq = d.content_faq.slice(0, 6);
  if (d.kind === 'consult') {
    if (d.content_sample_qa.length) a.content_sample_qa = d.content_sample_qa.slice(0, 3);
    if (Object.keys(d.join_requirements).length) a.join_requirements = d.join_requirements;
    // commercial_* keys (incl. commercial_preparation_instructions, typed in step 6
    // but a POLICY field like the rest of the commercial_* bundle) are added by
    // withCommercialPolicy() below, never here — see that function's comment.
  }
  if (d.kind === 'ai_agent') {
    if (d.content_sample_chat.length) a.content_sample_chat = d.content_sample_chat.slice(0, 6);
    if (d.content_can_do.length) a.content_can_do = d.content_can_do.slice(0, 3);
    if (d.content_cant_do.length) a.content_cant_do = d.content_cant_do.slice(0, 3);
    if (Object.keys(d.join_requirements).length) a.join_requirements = d.join_requirements;
  }
  if (d.kind === 'live_event') {
    // Only set once the creator has actually touched this step (default 24 is a
    // legitimate value, but we don't want to write it before step 7 is reached).
  }
  return a;
}

/** Live/consult commercial policy — set only once step 7 has been visited, via
 *  a separate flag the caller (ListingWizard) tracks; see visitedStep7 param. */
export function withCommercialPolicy(attrs: Record<string, unknown>, d: ListingDraft, includePolicy: boolean): Record<string, unknown> {
  if (!includePolicy) return attrs;
  const out = { ...attrs };
  if (d.kind === 'live_event') {
    out.commercial_refund_window_hours = d.commercial_refund_window_hours;
  } else if (d.kind === 'consult') {
    out.commercial_cancellation_window_hours = d.commercial_cancellation_window_hours;
    out.commercial_reschedule_allowed = d.commercial_reschedule_allowed;
    out.commercial_booking_notice_hours = d.commercial_booking_notice_hours;
    out.commercial_no_show_policy = 'session_charged';
    if (d.commercial_preparation_instructions.trim()) {
      out.commercial_preparation_instructions = d.commercial_preparation_instructions.slice(0, 600);
    } else if (out.commercial_preparation_instructions === undefined) {
      out.commercial_preparation_instructions = '';
    }
  }
  return out;
}

/** Full body for a PUT/POST at a given step — always cumulative (every field
 *  collected so far), because a creator can jump back to an earlier step and
 *  the server's PUT only changes the keys present in the body; missing keys
 *  are left alone, so re-sending everything each time is what keeps a
 *  backward jump from silently losing a later step's data on the NEXT save. */
export function bodyForSave(d: ListingDraft, opts: { includeAttrs: boolean; includePolicy: boolean }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    kind: d.kind,
    free_entry: d.free_entry,
    schedule_mode: d.schedule_mode,
    title: d.title.trim(),
    blurb: d.blurb.trim() || undefined,
    description: d.description.trim() || undefined,
    category: d.category || undefined,
    vibe_tags: d.vibe_tags,
    spoken_lang: d.spoken_lang.length ? d.spoken_lang.join(',') : undefined,
    price: d.free_entry ? 0 : (d.price ? Math.round(Number(d.price)) : 0),
    billing_unit: d.billing_unit,
    timezone: d.timezone,
    max_per_booking: d.max_per_booking,
    video_url: d.video_url.trim() || undefined,
    location: d.location.trim() || undefined,
    adults_only: d.adults_only,
    credential: d.credential.trim() || undefined,
    cover_media: d.cover_media,
  };
  if (d.response_time_min !== '') body.response_time_min = Math.trunc(Number(d.response_time_min));
  if (d.schedule_mode === 'fixed_date') {
    body.starts_at = localToEpoch(d.starts_at);
    body.duration_min = d.duration_min;
  } else if (d.schedule_mode === 'recurring') {
    body.recurrence_days = d.recurrence_days;
    body.recurrence_time = d.recurrence_time;
    body.duration_min = d.duration_min;
  }
  // Live events: the seat cap the booking box counts down. 0/blank = unlimited.
  if (d.kind === 'consult') body.capacity = 1;
  else if (d.capacity && d.capacity > 0) body.capacity = d.capacity;
  if (opts.includeAttrs) {
    body.attrs = withCommercialPolicy(buildAttrs(d), d, opts.includePolicy);
  }
  return body;
}

export interface FieldProblem { field: string; message: string }

/** Client mirror of listingContentFieldsError + contentAttrsError +
 *  commercialPolicyError, scoped to what a given step just collected. Returns
 *  the FIRST problem found, same "stop at the first thing that's wrong"
 *  posture as the server. */
export function validateStep(d: ListingDraft, step: StepIndex): FieldProblem | null {
  switch (step) {
    case 0: // Type
      if (d.free_entry && (!Number.isInteger(Number(d.content_free_cap_tokens)) || Number(d.content_free_cap_tokens) <= 0)) {
        return { field: 'content_free_cap_tokens', message: 'Set a token cap you’re willing to spend from your wallet for this free show.' };
      }
      return null;
    case 1: // Pitch
      if (d.title.trim().length < 3) return { field: 'title', message: 'Give your listing a title (at least 3 characters).' };
      if (d.blurb.length > 120) return { field: 'blurb', message: 'The blurb must be at most 120 characters.' };
      if (!d.category) return { field: 'category', message: 'Pick a category.' };
      if (d.vibe_tags.length > 2) return { field: 'vibe_tags', message: 'Pick up to 2 vibe tags.' };
      return null;
    case 2: // Money
      if (!d.free_entry) {
        const p = Number(d.price);
        if (!Number.isFinite(p) || p < 0) return { field: 'price', message: 'Enter a whole number of tokens, or 0 for free.' };
      }
      if (!(BILLING_UNITS as readonly string[]).includes(d.billing_unit)) return { field: 'billing_unit', message: 'Pick what the price is charged per.' };
      if (d.early_bird_pct && !(Number(d.early_bird_pct) >= 1 && Number(d.early_bird_pct) <= 100)) {
        return { field: 'early_bird_pct', message: 'Early-bird discount must be 1–100%.' };
      }
      return null;
    case 3: { // Time
      if (!isValidTimezone(d.timezone)) return { field: 'timezone', message: 'Pick a valid timezone.' };
      if (d.schedule_mode === 'fixed_date') {
        const ms = localToEpoch(d.starts_at);
        if (ms === null) return { field: 'starts_at', message: 'Pick the date and time this starts.' };
        if (ms <= Date.now()) return { field: 'starts_at', message: 'The start time needs to be in the future.' };
        if (d.duration_min < 5 || d.duration_min > 480) return { field: 'duration_min', message: 'Length must be between 5 minutes and 8 hours.' };
      }
      if (d.schedule_mode === 'recurring') {
        if (!d.recurrence_days.length) return { field: 'recurrence_days', message: 'Pick at least one day of the week.' };
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.recurrence_time)) return { field: 'recurrence_time', message: 'Pick a valid time.' };
        if (d.duration_min < 5 || d.duration_min > 480) return { field: 'duration_min', message: 'Length must be between 5 minutes and 8 hours.' };
      }
      if (d.max_per_booking < 1 || d.max_per_booking > 20) return { field: 'max_per_booking', message: 'Bookings per person must be 1–20.' };
      if (d.response_time_min !== '' && (!Number.isInteger(Number(d.response_time_min)) || Number(d.response_time_min) < 0)) {
        return { field: 'response_time_min', message: 'Typical reply time must be a non-negative number of minutes.' };
      }
      return null;
    }
    case 4: // How it works
      if (d.content_how_it_works.length < 2 || d.content_how_it_works.length > 5) {
        return { field: 'content_how_it_works', message: 'Add 2–5 steps explaining how this works.' };
      }
      if (d.content_how_it_works.some((s) => !s.label.trim() || s.label.length > 24 || !s.body.trim() || s.body.length > 240)) {
        return { field: 'content_how_it_works', message: 'Each step needs a label (≤24 chars) and a body (≤240 chars).' };
      }
      return null;
    case 5: // House rules
      if (d.content_house_rules.length < 3 || d.content_house_rules.length > 8) {
        return { field: 'content_house_rules', message: 'Add 3–8 house rules.' };
      }
      if (d.content_house_rules.some((r) => !r.heading.trim() || r.heading.length > 32 || !r.body.trim() || r.body.length > 200)) {
        return { field: 'content_house_rules', message: 'Each rule needs a heading (≤32 chars) and a body (≤200 chars).' };
      }
      if (d.content_house_rules_intro.length > 280) return { field: 'content_house_rules_intro', message: 'Keep the intro under 280 characters.' };
      if (d.content_what_you_get.length && (d.content_what_you_get.length < 3 || d.content_what_you_get.length > 5)) {
        return { field: 'content_what_you_get', message: 'List 3–5 things people get.' };
      }
      if (d.content_faq.length && (d.content_faq.length < 3 || d.content_faq.length > 6)) {
        return { field: 'content_faq', message: 'Add 3–6 FAQ entries, or remove the section entirely.' };
      }
      return null;
    case 6: // Photos & policy
      if (!d.cover_media.length) return { field: 'cover_media', message: 'Add at least one photo.' };
      if (d.kind === 'consult' && d.commercial_preparation_instructions.length > 600) {
        return { field: 'commercial_preparation_instructions', message: 'Keep preparation instructions under 600 characters.' };
      }
      return null;
    default:
      return null;
  }
}

/** Required-for-`live_event` at publish (spec §F): blurb, how-it-works, house rules. */
export function publishReadiness(
  d: ListingDraft,
  /** [CARD-AI-REVIEW-1] Whether the copy review has run in THIS session. It is
   *  session state on purpose: there is no column on `listings` recording a
   *  review, so persisting it would mean inventing one. Re-running the review
   *  is one click on the Pitch step, and the server-side backstop (a follow-up)
   *  is what will make this durable. Until then, do not fake a stored flag. */
  opts: { copyReviewed?: boolean } = {},
): { ok: boolean; label: string }[] {
  const checks = [
    { ok: Boolean(opts.copyReviewed), label: 'Ava has reviewed the copy' },
    { ok: d.title.trim().length >= 3, label: 'Has a title' },
    { ok: Boolean(d.category), label: 'Has a category' },
    { ok: d.cover_media.length >= 1, label: `Has at least one photo (${d.cover_media.length}/5)` },
    { ok: d.blurb.trim().length > 0, label: 'Has a one-line blurb' },
    { ok: d.content_how_it_works.length >= 2, label: 'How it works is filled in' },
    { ok: d.content_house_rules.length >= 3, label: 'House rules are filled in' },
  ];
  if (d.schedule_mode === 'fixed_date') {
    checks.push({ ok: Boolean(localToEpoch(d.starts_at)) && Number(localToEpoch(d.starts_at)) > Date.now(), label: 'Starts in the future' });
    checks.push({ ok: d.duration_min >= 5 && d.duration_min <= 480, label: 'Length is set' });
  }
  if (d.schedule_mode === 'recurring') {
    checks.push({ ok: d.recurrence_days.length > 0, label: 'Recurring days are set' });
  }
  if (d.free_entry) {
    checks.push({ ok: Number.isInteger(Number(d.content_free_cap_tokens)) && Number(d.content_free_cap_tokens) > 0, label: 'Free-show token cap is set' });
  }
  return checks;
}
