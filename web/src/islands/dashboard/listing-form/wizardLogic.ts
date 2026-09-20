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
import { epochForDateTime } from '../../../lib/availability';

/* [PROMO-SHELVE-1 2026-09-13] Listing promotions (early-bird discount + promo
 * code) are SHELVED, not deleted. The server has the authority: a
 * `listingPromotionsEnabled` kill switch in worker/src/routes/config.ts
 * defaults FALSE, and with it off POST /api/listings/:id/promotions is refused
 * and a submitted `promo_code` comes back 400 `promotions_disabled`.
 *
 * This is the WEB WIZARD's matching switch, and it is the ONLY thing to flip in
 * the creator flow to bring the feature back. It is a local constant rather
 * than a read of /api/config on purpose: the wizard's existing config read
 * (`conferenceEnabled`) starts FALSE and resolves asynchronously, so wiring the
 * promo fields to it would make them flash into existence a beat after the step
 * paints — and, worse, would let the client show a field the server may still
 * refuse. Hard-false here can never disagree with itself.
 *
 * TO RE-ENABLE the creator side: set this to true (and flip
 * `listingPromotionsEnabled` on the server). Everything it gates — the step-3
 * fields, the "What a customer pays" table, the step-3 validation rules, the
 * step-8 summary rows, saveEarlyBirdAndPromo() and the /promotions hydrate —
 * is still here, untouched, behind this one boolean.
 *
 * It lives in wizardLogic.ts rather than types.ts only because types.ts already
 * imports this module — a value import the other way round would be a real
 * module cycle.
 *
 * Typed `: boolean` deliberately, so TypeScript does not narrow the guarded
 * blocks to unreachable dead code while the flag is off.
 */
export const LISTING_PROMOTIONS_ENABLED: boolean = false;

export const VIBE_TAGS = ['safe_space', 'cam_optional', 'listener_first', 'savage', 'beginner_ok', 'queer_friendly', 'women_only'] as const;
export const BILLING_UNITS = ['session', 'minute', '10min', 'chat', 'night', 'game'] as const;
export const SCHEDULE_MODES = ['fixed_date', 'recurring', 'on_request', 'always_on'] as const;
export const REFUND_WINDOWS = [0, 12, 24, 48] as const;
export const BOOKING_NOTICE_HOURS = [1, 2, 6, 24] as const;

export function localToEpoch(value: string, timezone?: string): number | null {
  if (!value) return null;
  try {
    const [date, time] = value.split('T');
    if (timezone && date && time) return epochForDateTime(date, time, timezone);
  } catch { return null; }
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function epochToLocal(ms: number | null | undefined, timezone?:string): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if(timezone){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d);const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;}
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
    /* [WIZ-EDIT-CLEAR-1 2026-09-14] SEND THE EMPTY STRING, do not drop the key.
     *
     * The server's PUT only touches keys that are PRESENT (normFields in
     * worker/src/routes/listings.ts), so `|| undefined` meant a creator editing
     * a saved listing could add to these fields but never empty one: delete the
     * description, press Save and continue, reload — the old description is
     * back, with no error and nothing to tell them the deletion did not take.
     * normFields maps '' the way the control promises (description stores '',
     * location and video_url store NULL), so the empty string is the right
     * wire value for "the creator cleared this". */
    description: d.description.trim(),
    category: d.category || undefined,
    // [MKT-3GROUP-1] The Vibe tags control is gone from the UI (owner decision
    // 2026-09-05) — always send an empty array rather than whatever an old
    // draft happened to load with, per spec §6 step 2.
    vibe_tags: [],
    spoken_lang: d.spoken_lang.join(','),
    price: d.free_entry ? 0 : (d.price ? Math.round(Number(d.price)) : 0),
    // [PRICE-HOURLY-1] Every session is priced per hour now — the "Charged
    // per" dropdown is gone and the server forces this value anyway; send it
    // explicitly rather than whatever `d.billing_unit` holds from an older draft.
    billing_unit: 'hour',
    media_mode: d.media_mode,
    timezone: d.timezone,
    // [WIZ-SIMPLIFY-1] `max_per_booking` is no longer asked for — the wizard
    // dropped the field (owner decision). The server defaults it to 4 when the
    // key is absent (worker/src/routes/listings.ts:1276 on PUT, :1490 on
    // create), so leaving it out is the same value the form used to send.
    video_url: d.video_url.trim(),
    location: d.location.trim(),
    adults_only: d.adults_only,
    credential: d.credential.trim() || undefined,
    cover_media: d.cover_media,
  };
  if (d.response_time_min !== '') body.response_time_min = Math.trunc(Number(d.response_time_min));
  if (d.schedule_mode === 'fixed_date') {
    body.starts_at = localToEpoch(d.starts_at, d.timezone);
    body.duration_min = d.duration_min;
  } else if (d.schedule_mode === 'recurring') {
    body.recurrence_days = d.recurrence_days;
    body.recurrence_time = d.recurrence_time;
    body.duration_min = d.duration_min;
  }
  // Live events: the seat cap the booking box counts down. 0/blank = unlimited.
  // [WIZ-EDIT-CLEAR-1] Always sent for a non-consult. Omitting it on 0 meant the
  // seats field could be raised but never cleared — blanking "60" left 60 on the
  // server, and the listing kept selling out at a cap the creator had removed.
  // normFields turns a falsy capacity into NULL, which is exactly "unlimited".
  if (d.kind === 'consult') body.capacity = 1;
  else body.capacity = d.capacity && d.capacity > 0 ? d.capacity : 0;
  if (opts.includeAttrs) {
    body.attrs = withCommercialPolicy(buildAttrs(d), d, opts.includePolicy);
  }
  return body;
}

export interface FieldProblem { field: string; message: string }

/** [WIZ-AI-REVIEWED-TEXT-1 2026-09-14] The gate remembers TEXT, not booleans.
 *
 *  A boolean `aiAssisted` was session-only, so reopening a SAVED listing to edit
 *  it (My listings -> Edit -> step 2) demanded three fresh AI calls on copy the
 *  creator had already run the check on and the reviewer had already accepted.
 *  That made an existing listing effectively uneditable.
 *
 *  What the gate actually wants is "Ava has seen the words you are about to
 *  save". So each field records the exact text that was last settled — applied
 *  from a suggestion, or explicitly kept — and a field is satisfied while its
 *  current text still equals that. Seeded on load from what the SERVER returned
 *  (see ListingWizard's load effect), which is copy that already went through
 *  this gate before it was saved; edit that text and the field falls out of
 *  agreement and is gated again, which is the original intent.
 *
 *  `null` means "never reviewed" — the state a brand-new draft starts in. It is
 *  deliberately distinct from `''`, which is a legitimately reviewed empty
 *  description on a saved listing.
 *
 *  Still client-side and still never sent: no new server attrs key exists for
 *  this, by design.
 */
export interface ReviewedCopy { title: string | null; blurb: string | null; description: string | null }

export const REVIEWED_COPY_NONE: ReviewedCopy = { title: null, blurb: null, description: null };

const COPY_FIELDS = ['title', 'blurb', 'description'] as const;

/** Text equality as the gate means it: trailing whitespace is not an edit. */
function sameCopy(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.trim() === b.trim();
}

/** True when all three pitch fields still hold the text that was reviewed.
 *  `skipped` is the "Continue without AI" escape after a failed call — it
 *  releases the WHOLE gate for the rest of the sitting, so a dead endpoint can
 *  never trap a creator on step 2 no matter what they type afterwards. */
export function copyGateSatisfied(d: ListingDraft, reviewed: ReviewedCopy, skipped = false): boolean {
  if (skipped) return true;
  return COPY_FIELDS.every((f) => sameCopy(d[f] ?? '', reviewed[f]));
}

/** Which of the three fields is still out of agreement — drives the per-field
 *  "✓ AI checked" vs. "Write my … for me" state on step 2. */
export function copyFieldReviewed(d: ListingDraft, reviewed: ReviewedCopy, field: 'title' | 'blurb' | 'description', skipped = false): boolean {
  return skipped || sameCopy(d[field] ?? '', reviewed[field]);
}

export const AI_ASSIST_GATE_MESSAGE =
  'Run the AI check on your title, blurb and description before continuing.';

/** [WIZ-ERR-ONCE-1 2026-09-14] Fields whose step already renders an inline
 *  <ErrLine> under the control. The wizard's general error banner skips these,
 *  otherwise the identical sentence renders twice on the same screen — verified
 *  in the DOM for `ai_assist` on step 2, but true of every field in this set.
 *  Keep it in step with the ErrLine calls in steps.tsx. */
export const INLINE_ERROR_FIELDS: ReadonlySet<string> = new Set([
  'title', 'blurb', 'ai_assist', 'category',
  'price', 'early_bird_pct', 'promo_code', 'promo_pct',
  'timezone', 'availability_rules', 'starts_at', 'duration_min',
  'recurrence_days', 'recurrence_time', 'response_time_min', 'capacity',
  'cover_media',
]);

/** Client mirror of listingContentFieldsError + contentAttrsError +
 *  commercialPolicyError, scoped to what a given step just collected. Returns
 *  the FIRST problem found, same "stop at the first thing that's wrong"
 *  posture as the server. */
export function validateStep(
  d: ListingDraft,
  step: StepIndex,
  opts: { reviewedCopy?: ReviewedCopy; aiSkipped?: boolean } = {},
): FieldProblem | null {
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
      // [WIZ-AI-ASSIST-1] The AI copy check moved from step 8 to here, where the
      // words are actually being written, and it is a gate rather than a
      // decoration: a creator leaves this step having seen what Ava would do
      // with each of the three fields. IDEMPOTENT — once all three are marked
      // this passes silently and nothing re-runs. When the call itself fails,
      // Step2Pitch offers "Continue without AI" (`aiSkipped`), which releases the
      // gate outright, so a dead endpoint can never trap a creator on this step.
      //
      // [WIZ-AI-REVIEWED-TEXT-1] Satisfied by TEXT, not by a boolean: copy that
      // came back from the server unchanged is already reviewed, so reopening a
      // saved listing does not re-demand three calls. Edit a field and it falls
      // out of agreement and is asked for again.
      if (opts.reviewedCopy) {
        if (!copyGateSatisfied(d, opts.reviewedCopy, opts.aiSkipped)) {
          return { field: 'ai_assist', message: AI_ASSIST_GATE_MESSAGE };
        }
      }
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
          return { field: 'price', message: `The lowest price is ₹${PRICING.minPriceTokensPerHour}/hour — below that, Saathum’s flat fee leaves you with nothing.` };
        }
      }
      // [PROMO-SHELVE-1 2026-09-13] OFF THE ACTIVE PATH while promotions are
      // hidden. Step 3 no longer renders the early-bird / promo-code / promo-%
      // fields, and a creator must never be blocked by a field they cannot see
      // — a stale value hydrated from an older draft would otherwise wedge the
      // stepper with an error pointing at nothing. The rules themselves are
      // unchanged and come back with LISTING_PROMOTIONS_ENABLED.
      if (LISTING_PROMOTIONS_ENABLED) {
        if (d.early_bird_pct && !(Number(d.early_bird_pct) >= 1 && Number(d.early_bird_pct) <= 100)) {
          return { field: 'early_bird_pct', message: 'Early-bird discount must be 1–100%.' };
        }
        // [WIZ-DISCOUNT-1] The promo code carries its own percentage now. The
        // wizard used to POST `pct_off: 10` for a code typed without an
        // early-bird number — a discount nobody chose. Ask for it instead.
        if (d.promo_pct && !(Number(d.promo_pct) >= 1 && Number(d.promo_pct) <= 100)) {
          return { field: 'promo_pct', message: 'Promo code discount must be 1–100%.' };
        }
        if (d.promo_code.trim() && !d.promo_pct) {
          return { field: 'promo_pct', message: 'Give the promo code a discount % (1–100), or clear the code.' };
        }
        if (d.promo_pct && !d.promo_code.trim()) {
          return { field: 'promo_code', message: 'Give the discount a code buyers can type, or clear the %.' };
        }
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
      const consultNeedsFixedWindow = d.kind !== 'consult' || d.availability_mode === 'exclusive';
      if (d.schedule_mode === 'fixed_date' && consultNeedsFixedWindow && !d.starts_at) {
        return { field: 'starts_at', message: 'Pick the date and time this starts.' };
      }
      if (d.schedule_mode === 'fixed_date' && consultNeedsFixedWindow && d.starts_at) {
        const ms = localToEpoch(d.starts_at, d.timezone);
        if (ms === null) return { field: 'starts_at', message: 'Pick the date and time this starts.' };
        if (ms <= Date.now()) return { field: 'starts_at', message: 'The start time needs to be in the future.' };
        if (d.duration_min < 5 || d.duration_min > 480) return { field: 'duration_min', message: 'Length must be between 5 minutes and 8 hours.' };
      }
      if (d.schedule_mode === 'fixed_date' && (d.duration_min < 5 || d.duration_min > 480)) {
        return { field: 'duration_min', message: 'Length must be between 5 minutes and 8 hours.' };
      }
      if (d.schedule_mode === 'recurring') {
        if (!d.recurrence_days.length) return { field: 'recurrence_days', message: 'Pick at least one day of the week.' };
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.recurrence_time)) return { field: 'recurrence_time', message: 'Pick a valid time.' };
        if (d.duration_min < 5 || d.duration_min > 480) return { field: 'duration_min', message: 'Length must be between 5 minutes and 8 hours.' };
      }
      if (d.kind === 'consult' && d.availability_mode !== 'exclusive' && (d.duration_min < 5 || d.duration_min > 480)) {
        return { field: 'duration_min', message: 'Length must be between 5 minutes and 8 hours.' };
      }
      if (d.kind === 'consult' && d.availability_mode === 'custom') {
        if (!d.availability_rules.length) return { field: 'availability_rules', message: 'Add at least one weekly window for custom consult hours.' };
        const bad = d.availability_rules.some((r) => r.weekday < 0 || r.weekday > 6 || r.start_min < 0 || r.end_min > 1440 || r.end_min <= r.start_min);
        if (bad) return { field: 'availability_rules', message: 'Each consult window needs a valid start and end time.' };
      }
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
    case 6: // Photos & policy — all media is optional
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

/**
 * [WIZ-SUBMIT-PLAIN-1] The step-8 list is INFORMATIONAL ONLY and gates nothing.
 *
 * It used to be built around POST /api/listings/:id/review, and the first line
 * ("Check your listing — not run yet") was what disabled Submit until the
 * creator pressed "Run the check". That button is gone (owner decision): step 8
 * is now a plain read-only summary of what was submitted plus the Submit
 * button. The server still validates on submit — POST /api/listings/:id/submit
 * returns the listing blockers — so the authority never moved; only the second
 * opinion in the browser did.
 *
 * Every line here is `info`, and Step8Preview renders `info` lines with a dot
 * rather than a tick, precisely so nothing in this list reads as a verdict.
 * Do NOT reintroduce a blocking line: the caller no longer has anything to run
 * that could clear it, so a false line here would lock Submit forever.
 */
export function publishReadiness(d: ListingDraft): ReadinessCheck[] {
  return [
    { ok: true, info: true, label: d.cover_media.length ? `Photos added (${d.cover_media.length}/5)` : 'No photos — a poster will be generated after submit' },
    { ok: true, info: true, label: d.content_how_it_works.length ? `How it works (${d.content_how_it_works.length} step${d.content_how_it_works.length === 1 ? '' : 's'})` : 'How it works — optional, left blank' },
    { ok: true, info: true, label: d.content_house_rules.length ? `House rules (${d.content_house_rules.length})` : 'House rules — optional, left blank' },
  ];
}

/* [WIZ-EDIT-RESUME-1 2026-09-14] Where to open an EXISTING listing.
 *
 * Reopening a listing that had been walked all the way to step 8 dropped the
 * creator back on step 1 (Type) and made them press "Save and continue" seven
 * times to reach the thing they came to change. There is no stored step to
 * restore — the wizard has never persisted one, and inventing a server key for
 * it is not warranted — so the progress signal is the draft ITSELF: walk the
 * steps in order and stop at the first one that is still incomplete.
 *
 * That lands an unfinished draft on the first thing that actually needs
 * attention (which is also the furthest point it could legitimately advance to
 * on its own), and a complete listing on step 8, the summary. The AI copy gate
 * is deliberately NOT consulted here: it is a gate on leaving step 2, not a
 * statement about whether the step has data, and using it would park every
 * reopened listing on Pitch.
 *
 * Brand-new drafts never call this — ListingWizard only uses it when ?id= was
 * present — so the create flow still starts at step 1.
 */
export function resumeStepFor(d: ListingDraft): StepIndex {
  // A listing that is out of the creator's hands (in review, approved, live,
  // rejected) has nothing to fill in — step 8 is the screen that says so.
  if (d.status && d.status !== 'draft') return 7;
  for (let i = 0 as StepIndex; i < 7; i = (i + 1) as StepIndex) {
    if (validateStep(d, i)) return i;
  }
  return 7;
}
