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
import { PRICING } from '../../../lib/listingTaxonomy';

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
  // [FACE-PHOTO-1 2026-09-05] The likeness reference for the poster. Lives in
  // attrs rather than cover_media on purpose: cover_media IS the public gallery,
  // and this photo must never appear there. Only sent when set, so an older
  // draft round-trips unchanged.
  if (d.face_photo) a.face_photo = { url: d.face_photo };
  // [LIST-OPTIONAL-CONTENT-1] Send whatever the creator actually wrote. These
  // used to be `>= 2` / `>= 3`, which SILENTLY DISCARDED a single step or a
  // pair of rules — the creator typed them, hit save, and they were gone with
  // no error. Now that both sections are optional, one entry is a legitimate
  // answer, so it must round-trip. The server minimum was lowered to 1 to
  // match (contentAttrsError in worker/src/routes/listings.ts); keep the two
  // ends in step or a 1-item list starts 400ing.
  if (d.content_how_it_works.length) a.content_how_it_works = d.content_how_it_works.slice(0, 5);
  if (d.content_house_rules.length) a.content_house_rules = d.content_house_rules.slice(0, 8);
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
    // [MKT-3GROUP-1] The Vibe tags control is gone from the UI (owner decision
    // 2026-09-05) — always send an empty array rather than whatever an old
    // draft happened to load with, per spec §6 step 2.
    vibe_tags: [],
    spoken_lang: d.spoken_lang.length ? d.spoken_lang.join(',') : undefined,
    price: d.free_entry ? 0 : (d.price ? Math.round(Number(d.price)) : 0),
    // [PRICE-HOURLY-1] Every session is priced per hour now — the "Charged
    // per" dropdown is gone and the server forces this value anyway; send it
    // explicitly rather than whatever `d.billing_unit` holds from an older draft.
    billing_unit: 'hour',
    media_mode: d.media_mode,
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
    // [MKT-3GROUP-1] The free-show "token cap" is gone (owner decision
    // 2026-09-05) — a free show no longer asks what the creator is willing to
    // spend from their wallet, so step 0 has nothing left to validate.
    case 0: // Type
      return null;
    case 1: // Pitch
      if (d.title.trim().length < 3) return { field: 'title', message: 'Give your listing a title (at least 3 characters).' };
      // [WIZARD-VALIDATE-1 2026-09-05] The blurb is REQUIRED here, on the step
      // that collects it. It was only capped, never required — and it is a hard
      // requirement of the step-8 checklist, so a creator who skipped it sailed
      // through six more steps before being told, with no indication of which
      // step to go back to.
      if (!d.blurb.trim()) return { field: 'blurb', message: 'Write the one-line blurb — it is the line buyers read on the card.' };
      if (d.blurb.length > 120) return { field: 'blurb', message: 'The blurb must be at most 120 characters.' };
      if (!d.category) return { field: 'category', message: 'Pick one category.' };
      return null;
    case 2: // Money
      if (!d.free_entry) {
        const p = Number(d.price);
        // [PRICE-HOURLY-1] "or 0 for free" is gone: a free show is the
        // free_entry checkbox on step 1, not a price of zero, and this branch
        // only runs when that box is UNCHECKED. Letting 0 past here meant a
        // creator sailed through Money and first heard about it at step 8,
        // where submit refuses an unpriced listing — five steps from the field
        // they need to fix.
        if (!Number.isFinite(p) || p <= 0) return { field: 'price', message: 'Set a price per hour, or mark this a free show back on step 1.' };
        // The ₹49/hour floor — below it the flat ₹25 fee leaves the creator
        // with nothing, which is why the server refuses it too. Surface the
        // reason here rather than let it round-trip as a 400.
        if (p < PRICING.minPriceTokensPerHour) {
          return { field: 'price', message: `The lowest price is ₹${PRICING.minPriceTokensPerHour}/hour — below that, avaTOK’s flat fee leaves you with nothing.` };
        }
      }
      if (d.early_bird_pct && !(Number(d.early_bird_pct) >= 1 && Number(d.early_bird_pct) <= 100)) {
        return { field: 'early_bird_pct', message: 'Early-bird discount must be 1–100%.' };
      }
      return null;
    case 3: { // Time
      if (!isValidTimezone(d.timezone)) return { field: 'timezone', message: 'Pick a valid timezone.' };
      // [WIZARD-VALIDATE-1 2026-09-05] A LIVE EVENT always needs a real window,
      // whatever its schedule_mode says.
      //
      // The checks below branch on schedule_mode alone, with no else — so a
      // live_event saved as 'always_on' or 'on_request' was asked for nothing at
      // all, passed this step, passed the step-8 checklist, reached review, was
      // approved by a human, and was then refused by publish forever. The owner
      // lost listing 845567cb to exactly that. Everything downstream of a live
      // event assumes a window: checkout refuses a ticket without one and the
      // stream join computes 1970 and locks out the host.
      //
      // The mode buttons for those cases are gone from the UI now, but this is
      // the check that has to hold, because a draft can arrive here from the API,
      // from an older saved listing, or from any path that never mounts Step4Time.
      if (d.kind === 'live_event' && d.schedule_mode !== 'fixed_date' && d.schedule_mode !== 'recurring') {
        return { field: 'starts_at', message: 'A live event needs a date and time — pick "One fixed date".' };
      }
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
    // [LIST-OPTIONAL-CONTENT-1 2026-09-04, owner decision] "How it works" and
    // "House rules" are OPTIONAL. They used to hard-block Next until a creator
    // wrote 2 steps / 3 rules, which stopped real listings from ever reaching
    // Publish over descriptive copy the marketplace does not need. Empty is
    // now a valid answer and the step is skippable.
    //
    // What is still enforced is only the shape of what someone DID write: a
    // step with an empty body, or one over the length caps, would be rejected
    // by the server's contentAttrsError() with a raw 400 the wizard cannot
    // explain. Catching it here keeps that error readable. Do not "simplify"
    // these into unconditional blocks again — that is the bug being fixed.
    case 4: // How it works — optional
      if (d.content_how_it_works.length > 5) {
        return { field: 'content_how_it_works', message: 'Keep it to 5 steps or fewer.' };
      }
      if (d.content_how_it_works.some((s) => !s.label.trim() || s.label.length > 24 || !s.body.trim() || s.body.length > 240)) {
        return { field: 'content_how_it_works', message: 'Each step you add needs a label (≤24 chars) and a body (≤240 chars) — or remove it.' };
      }
      return null;
    case 5: // House rules — optional
      if (d.content_house_rules.length > 8) {
        return { field: 'content_house_rules', message: 'Keep it to 8 house rules or fewer.' };
      }
      if (d.content_house_rules.some((r) => !r.heading.trim() || r.heading.length > 32 || !r.body.trim() || r.body.length > 200)) {
        return { field: 'content_house_rules', message: 'Each rule you add needs a heading (≤32 chars) and a body (≤200 chars) — or remove it.' };
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
      // [FACE-PHOTO-1] Required, and checked on the step that collects it.
      // The server enforces it too (a `face_photo_required` blocker), but a
      // creator should hear it here rather than two steps later on Submit.
      if ((d.kind === 'live_event' || d.kind === 'consult') && !d.face_photo) {
        return { field: 'face_photo', message: 'Upload a photo of your face — your poster is painted from it. It is not shown on your listing.' };
      }
      if (d.kind === 'consult' && d.commercial_preparation_instructions.length > 600) {
        return { field: 'commercial_preparation_instructions', message: 'Keep preparation instructions under 600 characters.' };
      }
      return null;
    default:
      return null;
  }
}

/** One line on the step-8 checklist. `info` lines can never block a submit and
 *  exist only so a creator can see what they did and did not fill in. */
export type ReadinessCheck = { ok: boolean; label: string; info?: boolean };

/** The server's verdict on this listing — POST /api/listings/:id/review. */
export type ListingReviewResult = {
  verdict: 'pass' | 'warn' | 'fail';
  model: 'ok' | 'unavailable' | 'off';
  issues: { severity: 'fail' | 'warn'; field: string | null; message: string; source: 'rules' | 'ai' }[];
};

/**
 * [WIZARD-VALIDATE-1 2026-09-05] The step-8 checklist, rebuilt around the
 * server's answer instead of a second opinion computed in the browser.
 *
 * What was wrong with the old one, in the owner's words: "the AI review at the
 * end is fake." Three separate problems:
 *
 *   1. Four of its seven base lines were literal `ok: true` — decorative rows
 *      that could never fail, padding a list that looked like scrutiny.
 *   2. The schedule lines were pushed only for `fixed_date` / `recurring`, with
 *      no else and no reference to `kind`, so a live_event with no start time
 *      had NO schedule line at all and the list went all-green.
 *   3. The first line claimed an AI check had "passed" when all that had
 *      happened was that a copy-length request returned. There was no verdict
 *      in the response to read.
 *
 * Now: the blocking lines come from the server (`review.issues` of severity
 * `fail`, which are exactly the rules publish enforces), the AI line reports the
 * real verdict, and the local lines that remain are marked `info` so it is
 * obvious they decide nothing. Until the review has actually run, the list is
 * NOT ready — an unknown answer is not a pass.
 */
export function publishReadiness(
  d: ListingDraft,
  opts: { review?: ListingReviewResult | null; reviewing?: boolean } = {},
): ReadinessCheck[] {
  const review = opts.review ?? null;
  const checks: ReadinessCheck[] = [];

  // ---- the one line that gates everything ----
  if (!review) {
    checks.push({
      ok: false,
      label: opts.reviewing ? 'Checking your listing…' : 'Check your listing — not run yet',
    });
  } else if (review.verdict === 'fail') {
    checks.push({ ok: false, label: `Check found ${review.issues.filter((i) => i.severity === 'fail').length} thing(s) that must be fixed` });
  } else {
    // Never claim more than actually happened. When the model could not run, the
    // deterministic half still did, and the label says exactly that rather than
    // implying a full review.
    checks.push({
      ok: true,
      label: review.model === 'ok'
        ? (review.verdict === 'warn' ? 'Checked — nothing blocking, some suggestions below' : 'Checked — no problems found')
        : 'Checked against the publishing rules (the AI reviewer was unavailable)',
    });
  }

  // ---- every blocking problem the server found, verbatim ----
  for (const i of review?.issues ?? []) {
    if (i.severity === 'fail') checks.push({ ok: false, label: i.message });
  }

  // ---- informational only: these decide nothing and say so ----
  checks.push({ ok: true, info: true, label: d.cover_media.length ? `Photos added (${d.cover_media.length}/5)` : 'No photos — the AI poster will be used' });
  checks.push({ ok: true, info: true, label: d.content_how_it_works.length ? `How it works (${d.content_how_it_works.length} step${d.content_how_it_works.length === 1 ? '' : 's'})` : 'How it works — optional, left blank' });
  checks.push({ ok: true, info: true, label: d.content_house_rules.length ? `House rules (${d.content_house_rules.length})` : 'House rules — optional, left blank' });

  return checks;
}
