/* [LIST-WIZ-1] The 8-step listing wizard — one island, one draft object.
 *
 * Spec: Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md §A1 item 4, §C.1,
 * §C.2, §F (the 8 steps) and Specs/SPEC-2026-09-02-LISTING-TRUST-AND-VIBE.md
 * §4.3 (attrs keys), §5 (voice). Replaces the old 4-field CreateListing.tsx +
 * the separate ListingPublish.tsx checklist screen — both files now just mount
 * this component (see their own headers for why: /new starts at step 1, the
 * dead-end /publish route starts at step 8 for an already-created draft).
 *
 * Autosave contract: a draft is created (POST) the moment step 2 (Pitch)
 * completes; every step after that PUTs the full accumulated body (not a
 * per-step diff) so jumping backward and re-advancing never drops a later
 * step's already-collected data — see wizardLogic.bodyForSave.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../../lib/clerk';
import { request, ApiError } from '../../../lib/apiClient';
import { API_BASE } from '../../../lib/config';
import { listingErrorMessage, isKycGate, isLivenessGate, apiErrorCode } from '../../../lib/listingErrors';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { IslandBoundary } from '../../../components/IslandBoundary';
import { capture, withTrace } from '../../../lib/analytics';
import { isEmbedded, embedNotifyDirty, embedNotifySubmitted } from '../../../lib/embed';
import { emptyDraft, STEP_LABELS } from './types';
import type { ListingDraft, StepIndex } from './types';
import { bodyForSave, buildAttrs, validateStep, publishReadiness, epochToLocal, normalizeTimezone, AI_ASSIST_GATE_MESSAGE, LISTING_PROMOTIONS_ENABLED } from './wizardLogic';
import type { AiAssisted } from './wizardLogic';
import type { CopyField } from './CopyReview';
import { defaultsFor } from '../../../lib/listingDefaults';
import { getCreatorSchedule, saveCreatorSchedule, previewCalendarConflicts, epochForDateTime } from '../../../lib/availability';
import type { CreatorSchedule } from '../../../lib/availability';
import {
  Step1Type, Step2Pitch, Step3Money, Step4Time, Step5HowItWorks, Step6HouseRules, Step7Photos, Step8Preview,
} from './steps';
import type { FieldErr } from './steps';

const MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif',
};
function inferImageMime(file: File): string | null {
  if (file.type) return file.type.startsWith('image/') ? file.type : null;
  const m = /\.[^.]+$/.exec(file.name.toLowerCase());
  return m ? IMAGE_EXT_MIME[m[0]] ?? null : null;
}

/** Reverse of bodyForSave — hydrate a Draft from GET /api/listings/:id. */
function draftFromListing(l: any): Partial<ListingDraft> {
  const attrs = (l.attrs && typeof l.attrs === 'object') ? l.attrs : {};
  const kind: ListingDraft['kind'] = l.kind === 'live' || l.kind === 'live_event' ? 'live_event' : l.kind === 'consult' ? 'consult' : 'ai_agent';
  return {
    id: l.id,
    status: l.status,
    // [POSTER-FIRST-1] Read-only mirror; never round-tripped (see PosterMirror).
    poster: (attrs.poster && typeof attrs.poster === 'object') ? attrs.poster : null,
    kind,
    free_entry: Boolean(l.free_entry),
    content_free_cap_tokens: attrs.content_free_cap_tokens != null ? String(attrs.content_free_cap_tokens) : '',
    schedule_mode: l.schedule_mode || 'fixed_date',
    title: l.title ?? '',
    blurb: l.blurb ?? '',
    description: l.description ?? '',
    category: l.category ?? '',
    media_mode: l.media_mode === 'audio_only' ? 'audio_only' : 'audio_video',
    // [MKT-3GROUP-1] Vibe tags are off in the UI; still hydrate whatever an
    // existing listing carries so a save never silently drops it — see
    // bodyForSave, which now always sends this straight through unedited.
    vibe_tags: Array.isArray(l.vibe_tags) ? l.vibe_tags : [],
    spoken_lang: typeof l.spoken_lang === 'string' && l.spoken_lang ? l.spoken_lang.split(',').filter(Boolean) : [],
    price: l.price != null ? String(l.price) : '',
    billing_unit: l.billing_unit || 'session',
    timezone: normalizeTimezone(l.timezone || 'Asia/Kolkata'),
    starts_at: epochToLocal(l.starts_at,normalizeTimezone(l.timezone || 'Asia/Kolkata')),
    duration_min: l.duration_min || 60,
    recurrence_days: Array.isArray(l.recurrence_days) ? l.recurrence_days : [],
    recurrence_time: l.recurrence_time || '18:00',
    response_time_min: l.response_time_min != null ? String(l.response_time_min) : '',
    capacity: l.capacity ?? 0,
    content_how_it_works: attrs.content_how_it_works ?? [],
    content_house_rules_intro: attrs.content_house_rules_intro ?? '',
    content_house_rules: attrs.content_house_rules ?? [],
    content_what_you_get: attrs.content_what_you_get ?? [],
    content_who_for: attrs.content_who_for ?? [],
    content_not_for: attrs.content_not_for ?? [],
    content_faq: attrs.content_faq ?? [],
    join_requirements: attrs.join_requirements ?? {},
    content_join_lead_minutes: attrs.content_join_lead_minutes ?? 5,
    content_sample_qa: attrs.content_sample_qa ?? [],
    credential: l.credential ?? '',
    commercial_preparation_instructions: attrs.commercial_preparation_instructions ?? '',
    content_sample_chat: attrs.content_sample_chat ?? [],
    content_can_do: attrs.content_can_do ?? [],
    content_cant_do: attrs.content_cant_do ?? [],
    cover_media: Array.isArray(l.cover_media) ? l.cover_media : [],
    // [FACE-PHOTO-1] Accept both the object shape we write and a bare string, so
    // a value set by any other path still hydrates rather than silently reading
    // as "not uploaded" and blocking the creator's own submit.
    face_photo: (() => {
      const f = (l.attrs as any)?.face_photo;
      const u = typeof f === 'string' ? f : (f?.url ?? null);
      return typeof u === 'string' && u.startsWith('https://') ? u : null;
    })(),
    video_url: l.video_url ?? '',
    location: l.location ?? '',
    adults_only: Boolean(l.adults_only),
    commercial_refund_window_hours: attrs.commercial_refund_window_hours ?? 24,
    commercial_cancellation_window_hours: attrs.commercial_cancellation_window_hours ?? 24,
    commercial_reschedule_allowed: attrs.commercial_reschedule_allowed ?? true,
    commercial_booking_notice_hours: attrs.commercial_booking_notice_hours ?? 6,
  };
}

interface CreatorInfo { name?: string | null; handle?: string | null; avatar?: string | null }

/** [WIZ-DISCOUNT-1] One row of `listing_promotions` as the server hands it back
 *  (GET /api/listings/:id/promotions). Kept so a re-save can be idempotent —
 *  see saveEarlyBirdAndPromo. */
interface PromoRow { id: string; kind: 'early_bird' | 'promo_code'; pct_off: number; code: string | null }

export function ListingWizard({ startAtPublish = false }: { startAtPublish?: boolean }) {
  const [draft, setDraft] = useState<ListingDraft>(() => emptyDraft());
  const [step, setStep] = useState<StepIndex>(startAtPublish ? 7 : 0);
  const [loading, setLoading] = useState(startAtPublish);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<FieldErr>({ field: null, message: null });
  const [gate, setGate] = useState<'liveness' | 'kyc' | null>(null);
  const [publishing, setPublishing] = useState(false);
  // [WIZ-AI-ASSIST-1 2026-09-13] Which of step 2's three fields have been
  // through the AI copy check. Session-only and never sent: it records a
  // decision the creator made in this sitting, not listing data. Step 2's Next
  // is gated on all three (validateStep case 1 + the guard in next()), and a
  // field counts once the creator applied a suggestion OR kept their own words.
  const [aiAssisted, setAiAssisted] = useState<AiAssisted>({ title: false, blurb: false, description: false });
  // [WIZ-DISCOUNT-1] The promotions this listing ALREADY has on the server.
  // Without this the wizard could only ever INSERT, so every pass through step
  // 3 stacked another early-bird row on the same listing.
  const [promoRows, setPromoRows] = useState<PromoRow[]>([]);
  const [availabilitySchedule, setAvailabilitySchedule] = useState<CreatorSchedule | null>(null);
  const [categories, setCategories] = useState<{ id: string; label: string; emoji?: string | null; group_id?: string | null }[]>([]);
  // [MKT-3GROUP-1] `adda_rooms` is a `find_your_people` blip gated on
  // `conferenceEnabled`, which is FALSE in production (verified on the live
  // config, not read from DEFAULTS — see CLAUDE.md). Fail closed: hidden
  // until the public, unauthenticated /api/config read actually says true.
  const [conferenceEnabled, setConferenceEnabled] = useState(false);
  const [creatorInfo, setCreatorInfo] = useState<CreatorInfo | undefined>(undefined);
  // [FREE-ENTRY-GATE-1] Fail closed: hidden until GET /api/listings/mine
  // (a per-user, authenticated read) actually says `free_entry_allowed ===
  // true` for THIS uid. This used to read the PUBLIC /api/config flag
  // (`freeEntryAllowlistOnly`), which is the same value for every visitor —
  // so it hid the checkbox from admins and allowlisted testers too, the
  // exact accounts the gate is supposed to let through. `free_entry_allowed`
  // is computed server-side by the same `freeEntryAllowed()` the create/edit
  // routes enforce, so the control's visibility now tracks the real
  // per-account verdict instead of a global posture.
  const [freeEntryLocked, setFreeEntryLocked] = useState(true);
  const stepStartRef = useRef<number>(Date.now());
  // Guards against a double-click on "Save and continue" firing two overlapping
  // background saves (which could double-POST the draft before its id comes
  // back) — a ref because it must be read synchronously, not after a re-render.
  const savingRef = useRef(false);

  function patch(p: Partial<ListingDraft>) {
    setDraft((d) => ({ ...d, ...p }));
    setFieldErr({ field: null, message: null });
  }

  // [LIST-WIZ-HOST-1] The live-preview card's host chip (steps.tsx PreviewCard)
  // needs the signed-in creator's name/avatar. This island is NOT inside a
  // <ClerkProvider> — see CreateListing.tsx's header on why a second one here
  // would break the page — so it can't call useUser(). Clerk's underlying JS
  // SDK still exposes a page-global `window.Clerk` regardless of which island
  // mounted the provider (SidebarUser), so read that instead; it loads
  // asynchronously, hence the short poll. Falls back to the guest handle
  // (same localStorage key SidebarUser reads) for a guest creator, and to
  // nothing at all (ListingTile shows "?" initials) if neither resolves.
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    function fromClerk(): boolean {
      const c = (window as unknown as { Clerk?: { user?: { fullName?: string | null; firstName?: string | null; username?: string | null; imageUrl?: string | null } } }).Clerk;
      const u = c?.user;
      if (!u) return false;
      setCreatorInfo({ name: u.fullName || u.firstName || null, handle: u.username || null, avatar: u.imageUrl || null });
      return true;
    }
    if (!fromClerk()) {
      try {
        const handle = localStorage.getItem('avatok_guest_handle');
        if (handle) setCreatorInfo({ name: null, handle, avatar: null });
      } catch { /* ignore */ }
    }
    const poll = window.setInterval(() => {
      if (cancelled) return;
      const c = (window as unknown as { Clerk?: { addListener?: (cb: () => void) => () => void } }).Clerk;
      if (c) {
        if (!unsub && c.addListener) unsub = c.addListener(() => { fromClerk(); });
        fromClerk();
        window.clearInterval(poll);
      }
    }, 300);
    return () => { cancelled = true; window.clearInterval(poll); try { unsub?.(); } catch { /* ignore */ } };
  }, []);

  // Consult time is owned by AvaCalendar. Hydrate the listing-specific view
  // when the draft is known; a shared schedule still comes back through the
  // same endpoint and keeps one creator timezone across all listings.
  useEffect(() => {
    if (!draft.id || draft.kind !== 'consult') return;
    let alive = true;
    void (async () => {
      try {
        const token = await getActiveToken();
        // [WIZ-TYPES-1] getActiveTokenWaited resolves to null when nothing
        // signs in inside the timeout. This hydrate is authenticated, so a null
        // token could only ever produce a 401 — skip it rather than send one.
        if (!token) return;
        const r = await getCreatorSchedule(token, draft.id);
        if (!alive) return;
        setAvailabilitySchedule(r.schedule);
        setDraft((d) => ({
          ...d,
          timezone: r.schedule.timezone || d.timezone,
          availability_mode: r.schedule.mode,
          availability_rules: r.schedule.rules,
          availability_version: r.schedule.version,
          duration_min: r.schedule.duration_min || d.duration_min,
        }));
      } catch { /* availability is optional until a consult is saved */ }
    })();
    return () => { alive = false; };
  }, [draft.id, draft.kind]);

  // categories — same source publishListing validates against, so nothing
  // picked here can be rejected at publish for not existing.
  useEffect(() => {
    void (async () => {
      try {
        const r = await request<{ categories?: typeof categories }>('/api/explore/categories');
        setCategories(r.categories ?? []);
      } catch { /* field stays empty; the wizard falls back to the static SUB_CATEGORIES mirror */ }
    })();
  }, []);

  // [MKT-3GROUP-1] Public, unauthenticated config read for `conferenceEnabled`
  // only — same fail-closed posture as the free-entry gate above: a failure
  // or a false leaves the adda_rooms blip hidden rather than shown-but-dead.
  useEffect(() => {
    void (async () => {
      try {
        const r = await request<{ conferenceEnabled?: boolean }>('/api/config');
        setConferenceEnabled(r.conferenceEnabled === true);
      } catch { /* stays hidden */ }
    })();
  }, []);

  // Load an existing draft when ?id= is present (both /new?id= edits and /publish?id=).
  useEffect(() => {
    let id: string | null = null;
    try { id = new URLSearchParams(window.location.search).get('id'); } catch { /* */ }
    if (!id) { setLoading(false); capture('listing_create_start', { kind: draft.kind }); return; }
    void (async () => {
      try {
        const token = await getActiveToken();
        const l = await request<any>(`/api/listings/${encodeURIComponent(id!)}`, { auth: token });
        const data = l?.listing ?? l ?? {};
        setDraft((d) => ({ ...d, ...draftFromListing(data) }));
        // [WIZ-DISCOUNT-1] `early_bird_pct` / `promo_code` are not columns on
        // the listing — they are rows in `listing_promotions`, so
        // draftFromListing cannot see them and the fields came back empty on
        // every reopen. Read them here and hydrate both the draft and the
        // bookkeeping the idempotent re-save needs.
        //
        // [PROMO-SHELVE-1 2026-09-13] Skipped while promotions are shelved:
        // step 3 renders none of these fields, so there is nothing to hydrate
        // and no reason to spend a round trip on a route the server is about to
        // start refusing. Comes back with LISTING_PROMOTIONS_ENABLED.
        if (LISTING_PROMOTIONS_ENABLED) {
          try {
            const pr = await request<{ promotions?: PromoRow[] }>(`/api/listings/${encodeURIComponent(id!)}/promotions`);
            const rows = (pr.promotions ?? []).filter((r) => r.kind === 'early_bird' || r.kind === 'promo_code');
            setPromoRows(rows);
            const eb = rows.find((r) => r.kind === 'early_bird');
            const pc = rows.find((r) => r.kind === 'promo_code');
            setDraft((d) => ({
              ...d,
              early_bird_pct: eb ? String(eb.pct_off) : d.early_bird_pct,
              promo_code: pc?.code ?? d.promo_code,
              promo_pct: pc ? String(pc.pct_off) : d.promo_pct,
            }));
          } catch { /* the discount fields stay blank; a save then creates them */ }
        }
      } catch { setError('Could not load this listing.'); }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    stepStartRef.current = Date.now();
    capture('listing_step_view', { step: STEP_LABELS[step] });
  }, [step]);

  // [LIST-EMBED-1] Tell the app whether closing the WebView now would throw work
  // away, so its ✕ can ask first. A draft that has reached the server (`id`) is
  // recoverable and does NOT count — the creator can resume it from My listings;
  // typed-but-unsaved text on steps 1-2 is what is actually at risk.
  const unsavedPitch = draft.id === null && (draft.title.trim() !== '' || draft.blurb.trim() !== '');
  useEffect(() => { embedNotifyDirty(unsavedPitch); }, [unsavedPitch]);

  // [FREE-ENTRY-GATE-1] Per-user, authenticated read of the SAME gate the
  // create/edit routes enforce (worker/src/lib/free_entry_gate.ts via
  // GET /api/listings/mine's `free_entry_allowed`). A failure leaves the
  // control hidden (fail closed), same posture as identity_required
  // elsewhere in this file: never show a control the server is going to 403.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const token = await getActiveToken();
        const r = await request<{ free_entry_allowed?: boolean }>('/api/listings/mine', { auth: token });
        if (!alive) return;
        const locked = r.free_entry_allowed !== true;
        setFreeEntryLocked(locked);
        if (locked) capture('listing_free_entry_control_hidden', { reason: 'not_allowlisted' });
      } catch {
        if (!alive) return;
        capture('listing_free_entry_control_hidden', { reason: 'capability_fetch_failed' });
      }
    })();
    return () => { alive = false; };
  }, []);

  const flavourKey = `${draft.category}:${draft.kind}`;

  // Auto-apply category defaults ONCE per (category,kind) pair, and only into
  // still-empty fields, the moment both are known (entering step 5). A creator's
  // own edits are never clobbered — defaultsAppliedFor gates re-application.
  useEffect(() => {
    if (step < 4 || !draft.category || draft.defaultsAppliedFor === flavourKey) return;
    if (draft.content_how_it_works.length || draft.content_house_rules.length) {
      // Something is already there (an edit, or a reload) — mark applied without overwriting.
      setDraft((d) => ({ ...d, defaultsAppliedFor: flavourKey }));
      return;
    }
    const dft = defaultsFor(draft.category, draft.kind);
    setDraft((d) => ({
      ...d,
      content_how_it_works: dft.howItWorks,
      content_house_rules_intro: dft.houseRulesIntro,
      content_house_rules: dft.houseRules,
      content_what_you_get: dft.whatYouGet,
      content_who_for: dft.whoFor,
      content_not_for: dft.notFor,
      content_faq: dft.faq,
      content_sample_qa: dft.sampleQa ?? [],
      content_sample_chat: dft.sampleChat ?? [],
      content_can_do: dft.canDo ?? [],
      content_cant_do: dft.cantDo ?? [],
      credential: d.credential || dft.credential || '',
      defaultsAppliedFor: flavourKey,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, draft.category, draft.kind]);

  /* [LIST-WIZ-PERF-1] Every "Save and continue" was measured at 6-8s in the
   * field. This function makes only ONE network round trip (a single POST or
   * PUT) — the multi-second cost was never a sequential-await chain inside it;
   * it was `next()` making the whole UI (including the click itself) wait on
   * that one round trip PLUS, on step 2, a further two sequential /promotions
   * POSTs (saveEarlyBirdAndPromo) before the stepper was allowed to move.
   * `next()` below now advances the step optimistically and runs this in the
   * background, so the round-trip time (whatever it is server-side) no longer
   * blocks the creator's forward progress through the form — only Publish
   * still waits on the network. `ms`/`fields` are captured on every attempt
   * (success or failure) so a slow save shows up in `listing_save` without
   * needing a repro. */
  async function saveDraft(currentStep: StepIndex): Promise<boolean> {
    setError(null);
    const startedAt = Date.now();
    const includeAttrs = draft.id !== null || currentStep >= 1;
    const includePolicy = currentStep >= 6;
    const body = bodyForSave(draft, { includeAttrs, includePolicy });
    const fields = Object.keys(body).length;
    try {
      const token = await getActiveToken();
      let id = draft.id;
      await withTrace(async () => {
        if (!id) {
          const r = await request<{ listing_id?: string }>('/api/listings', { method: 'POST', auth: token, body });
          id = r.listing_id ?? null;
        } else {
          await request(`/api/listings/${encodeURIComponent(id)}`, { method: 'PUT', auth: token, body });
        }
      });
      const ms = Date.now() - startedAt;
      if (!id) { setError('Could not save the draft. Try again.'); capture('listing_save', { outcome: 'error', status: 0, reason: 'no_id', step: STEP_LABELS[currentStep], ms, fields }); return false; }
      if (id !== draft.id) setDraft((d) => ({ ...d, id }));
      if (currentStep === 3) {
        const availabilityResult = await saveListingAvailability(token, { ...draft, id });
        if (!availabilityResult.ok) return false;
        if (availabilityResult.schedule) {
          const schedule = availabilityResult.schedule;
          setAvailabilitySchedule(schedule);
          setDraft((d) => ({ ...d, timezone: schedule.timezone, availability_mode: schedule.mode, availability_rules: schedule.rules, availability_version: schedule.version, duration_min: schedule.duration_min || d.duration_min }));
        }
      }
      capture('listing_save', { outcome: 'ok', status: 200, step: STEP_LABELS[currentStep], ms, fields });
      capture('listing_step_complete', { step: STEP_LABELS[currentStep], ms: Date.now() - stepStartRef.current });
      return true;
    } catch (e) {
      const ms = Date.now() - startedAt;
      // [LIST-ERR-SURFACE-1 2026-09-05] Pass `message` too.
      //
      // The 422 from contentAttrsError (worker/src/routes/listings.ts:1393) sends
      // `{error, message, field}` where BOTH strings are the same human sentence —
      // "content_how_it_works must be 1-5 items of {label<=24, body<=240}". This
      // call dropped `message`, and `detail` is absent on that response, so
      // listingErrorMessage() had nothing to work with and fell through to
      // "That didn't go through. Please try again" — on a wizard step where
      // retrying is guaranteed to fail the same way. The publish path (onSubmit,
      // below) has always passed all three; only the per-step save did not, which
      // is why publish errors read well and step-save errors did not.
      const msg = e instanceof ApiError
        ? listingErrorMessage(
            e.error,
            (e.body as { detail?: unknown } | null)?.detail,
            (e.body as { message?: unknown } | null)?.message,
          )
        : 'Could not save. Try again.';
      const field = e instanceof ApiError && e.body && typeof e.body === 'object' && 'field' in (e.body as any) ? String((e.body as any).field) : null;
      setError(msg);
      if (field) setFieldErr({ field, message: msg });
      // [FREE-ENTRY-GATE-1] Server-side refusal (worker/src/lib/free_entry_gate.ts) —
      // this account tried to create/hold free_entry=1 and isn't allowlisted. The
      // control should already be hidden for this account (see the config-driven
      // freeEntryLocked effect above), so reaching this means either a stale
      // client, a race with the config fetch, or an edited request — still worth
      // its own event so a spike is visible without grepping listing_save.reason.
      if (e instanceof ApiError && apiErrorCode(e) === 'free_entry_not_allowed') {
        capture('listing_free_entry_blocked', { step: STEP_LABELS[currentStep] });
      }
      capture('listing_field_error', { field: field ?? 'unknown', reason: e instanceof ApiError ? e.error : 'network' });
      capture('listing_save', {
        outcome: 'error', status: e instanceof ApiError ? e.status : 0,
        reason: e instanceof ApiError ? e.error : (e instanceof Error ? e.message : 'unknown'), step: STEP_LABELS[currentStep], ms, fields,
      });
      return false;
    }
  }

  async function saveListingAvailability(token: string | null, d: ListingDraft & { id: string | null }): Promise<{ ok: boolean; schedule?: CreatorSchedule }> {
    // [WIZ-TYPES-1] `token` is `string | null` (getActiveTokenWaited). Every
    // call below is authenticated, and the listing save that got us here has
    // already succeeded with the same token, so a null here means the session
    // went away mid-step — nothing useful to send.
    if (!d.id || !token) return { ok: true };
    let start = NaN;
    if (d.schedule_mode === 'fixed_date' && d.starts_at && (d.kind !== 'consult' || d.availability_mode === 'exclusive')) {
      try {
        const [date, time] = d.starts_at.split('T');
        start = epochForDateTime(date, time, d.timezone);
      } catch {
        setFieldErr({ field: 'starts_at', message: 'That local time does not exist in the selected timezone.' });
        setError('Choose a valid time in the selected timezone.');
        return { ok: false };
      }
    }
    if (Number.isFinite(start)) {
      const preview = await previewCalendarConflicts(token, { listing_id: d.id, start_at: start, end_at: start + d.duration_min * 60_000, timezone: d.timezone });
      if (!preview.ok) {
        const first = preview.conflicts[0];
        setFieldErr({ field: 'starts_at', message: first ? `This overlaps ${first.title || 'another commitment'}. Choose another time.` : 'That time conflicts with another commitment.' });
        setError('Choose a time that does not conflict with your calendar.');
        capture('availability_conflict_preview', { listing_id: d.id, kind: d.kind, conflicts: preview.conflicts.length });
        return { ok: false };
      }
    }
    if (d.kind !== 'consult') return { ok: true };
    try {
      const targetListing = d.id;
      let current = availabilitySchedule;
      if (!current || current.listing_id !== targetListing) current = (await getCreatorSchedule(token, targetListing)).schedule;
      const schedule: CreatorSchedule = {
        ...current,
        listing_id: targetListing,
        timezone: d.timezone,
        mode: d.availability_mode,
        duration_min: d.duration_min,
        slot_interval_min: Math.max(5, current.slot_interval_min || d.duration_min),
        horizon_days: 62,
        rules: d.availability_mode === 'custom' ? d.availability_rules : current.rules,
        version: current.version,
      };
      const saved = await saveCreatorSchedule(token, schedule);
      capture('availability_schedule_saved', { listing_id: targetListing, mode: schedule.mode, version: saved.schedule.version });
      return { ok: true, schedule: saved.schedule };
    } catch (e) {
      const msg = e instanceof ApiError ? listingErrorMessage(e.error, (e.body as any)?.detail, (e.body as any)?.message) : 'Could not save consult availability.';
      setError(msg); setFieldErr({ field: 'availability_rules', message: msg });
      return { ok: false };
    }
  }

  /* [WIZ-DISCOUNT-1 2026-09-13] Early-bird + promo code, made honest and
   * idempotent. Three separate bugs lived in the six lines this replaces:
   *
   *   1. A promo code typed with no early-bird percentage was posted as
   *      `pct_off: 10` — a discount the creator never chose, invented in the
   *      browser. The code has its own `promo_pct` field now.
   *   2. Both POSTs swallowed every failure in a bare `catch {}`, so a 400 or a
   *      dropped connection looked exactly like a saved discount.
   *   3. `listing_promotions` rows are only ever INSERTed by that route, and
   *      `early_bird_pct` / `promo_code` were never hydrated back into the
   *      draft — so reopening the wizard showed empty fields and passing step 3
   *      again posted a SECOND row for the same listing. Existing promotions
   *      are loaded into `promoRows` below, and this compares against them:
   *      unchanged is a no-op, changed is delete-then-recreate, cleared is a
   *      delete (DELETE /api/listings/:id/promotions/:pid).
   */
  async function saveEarlyBirdAndPromo(): Promise<void> {
    const id = draft.id;
    if (!id) return;
    const token = await getActiveToken();
    const failures: string[] = [];
    const nextRows: PromoRow[] = [];

    const del = async (pid: string) => {
      await request(`/api/listings/${encodeURIComponent(id)}/promotions/${encodeURIComponent(pid)}`, { method: 'DELETE', auth: token });
    };
    const add = async (body: Record<string, unknown>): Promise<string | null> => {
      const r = await request<{ promotion_id?: string }>(`/api/listings/${encodeURIComponent(id)}/promotions`, { method: 'POST', auth: token, body });
      return r.promotion_id ?? null;
    };

    const ebPct = Number(draft.early_bird_pct);
    const wantEb = draft.early_bird_pct !== '' && ebPct >= 1 && ebPct <= 100 ? ebPct : null;
    const promoPct = Number(draft.promo_pct);
    const code = draft.promo_code.trim().toUpperCase();
    const wantCode = code && promoPct >= 1 && promoPct <= 100 ? { code, pct: promoPct } : null;

    for (const kind of ['early_bird', 'promo_code'] as const) {
      const existing = promoRows.find((r) => r.kind === kind) ?? null;
      const unchanged = kind === 'early_bird'
        ? (existing != null && wantEb != null && existing.pct_off === wantEb)
        : (existing != null && wantCode != null && existing.pct_off === wantCode.pct && (existing.code ?? '') === wantCode.code);
      const want = kind === 'early_bird' ? wantEb != null : wantCode != null;
      if (unchanged && existing) { nextRows.push(existing); continue; }
      if (existing) {
        try { await del(existing.id); }
        catch { failures.push(kind === 'early_bird' ? 'the old early-bird discount could not be removed' : 'the old promo code could not be removed'); nextRows.push(existing); continue; }
      }
      if (!want) continue;
      try {
        const body = kind === 'early_bird'
          ? { kind, pct_off: wantEb }
          : { kind, pct_off: wantCode!.pct, code: wantCode!.code };
        const pid = await add(body);
        if (pid) nextRows.push({ id: pid, kind, pct_off: kind === 'early_bird' ? wantEb! : wantCode!.pct, code: kind === 'promo_code' ? wantCode!.code : null });
      } catch (e) {
        failures.push(kind === 'early_bird'
          ? `the early-bird discount was not saved${e instanceof ApiError ? ` (${e.error})` : ''}`
          : `the promo code was not saved${e instanceof ApiError ? ` (${e.error})` : ''}`);
      }
    }

    setPromoRows(nextRows);
    if (failures.length) {
      // Never silent: the main listing save succeeded, so without this the
      // creator walks away believing a discount exists that does not.
      setError(`Your listing was saved, but ${failures.join(' and ')}. Go back to Money and try again.`);
      capture('listing_promo_save', { outcome: 'error', failures: failures.length });
    } else {
      capture('listing_promo_save', { outcome: 'ok', early_bird: wantEb != null, promo_code: wantCode != null });
    }
  }

  async function next() {
    if (savingRef.current) return;
    const problem = validateStep(draft, step, { aiAssisted });
    if (problem) {
      setFieldErr({ field: problem.field, message: problem.message });
      setError(problem.message);
      capture('listing_field_error', { field: problem.field, step: STEP_LABELS[step] });
      return;
    }
    // [WIZ-AI-ASSIST-1] The same gate again, in the place that actually moves
    // the step. validateStep is the shared rule; this guard is what stops a
    // creator leaving step 2 with a field Ava has never seen. Idempotent by
    // construction — once all three are marked it never fires again, and
    // nothing re-runs.
    if (step === 1 && !(aiAssisted.title && aiAssisted.blurb && aiAssisted.description)) {
      setFieldErr({ field: 'ai_assist', message: AI_ASSIST_GATE_MESSAGE });
      setError(AI_ASSIST_GATE_MESSAGE);
      capture('listing_ai_assist_blocked', { ...aiAssisted });
      return;
    }
    // Steps 0 (Type) and 1 (Pitch) collect locally; the draft is created the
    // moment Pitch completes (spec: "create draft after step 2").
    if (step === 0) { setStep(1); return; }
    const currentStep = step;
    // [LIST-WIZ-PERF-1] Optimistic step transition: advance immediately and
    // save (plus, on step 2, the early-bird/promo follow-up) in the
    // background behind the "Saving…" pill next to the stepper — only
    // onSubmitForReview still blocks on the network. If the save turns out to have
    // failed, snap back to the step that failed so the error banner lands
    // where the creator can act on it, instead of surfacing on a later step.
    if (currentStep < 7) setStep((s) => (s + 1) as StepIndex);
    savingRef.current = true;
    setSaving(true);
    try {
      const ok = await saveDraft(currentStep);
      // [PROMO-SHELVE-1 2026-09-13] NOT CALLED while promotions are shelved.
      // With `listingPromotionsEnabled` off the server refuses
      // POST /api/listings/:id/promotions, and this function reports every
      // failure to the creator by design — so firing it would put a spurious
      // "your promo code was not saved" banner in front of someone who was
      // never shown a promo field. The function itself is untouched below.
      if (LISTING_PROMOTIONS_ENABLED && ok && currentStep === 2) await saveEarlyBirdAndPromo();
      if (!ok) setStep(currentStep);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  function back() { if (step > 0) setStep((s) => (s - 1) as StepIndex); }

  // ── cover upload — ports ListingPublish's flow verbatim (same endpoint,
  // same header contract), now writing into draft state instead of a
  // standalone panel's local state. ──────────────────────────────────────
  async function onUpload(files: FileList | null) {
    if (!files || !files.length || uploading || !draft.id) return;
    setUploading(true); setError(null);
    try {
      const token = await getActiveToken();
      if (!token) { setError('Please sign in again to upload photos.'); return; }
      const room = 5 - draft.cover_media.length;
      const added: { type: string; url: string }[] = [];
      const failures: string[] = [];
      for (const file of Array.from(files).slice(0, room)) {
        const mime = inferImageMime(file);
        if (!mime) { failures.push(`${file.name}: photos only, please.`); continue; }
        if (file.size > MAX_BYTES) { failures.push(`${file.name} is too large (max 8 MB).`); continue; }
        try {
          const res = await withTrace(() => fetch(`${API_BASE}/upload/public`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'x-content-type': mime, 'x-file-name': file.name, 'x-app': 'avatok' },
            body: file,
          }));
          if (!res.ok) { failures.push(`Couldn't upload ${file.name} (${res.status}).`); continue; }
          const body = await res.json() as { url?: string };
          if (body.url) added.push({ type: 'image', url: body.url });
        } catch (e) {
          failures.push(`Couldn't upload ${file.name}: ${e instanceof Error ? e.message : 'unknown error'}`);
        }
      }
      if (added.length) {
        const nextCovers = [...draft.cover_media, ...added];
        patch({ cover_media: nextCovers });
        try {
          await request(`/api/listings/${encodeURIComponent(draft.id)}`, { method: 'PUT', auth: token, body: { cover_media: nextCovers } });
          capture('listing_cover_upload', { outcome: 'ok', status: '200', count: added.length });
        } catch { failures.push('Photos uploaded but could not be saved.'); }
      }
      if (failures.length) setError(failures.join(' '));
    } finally { setUploading(false); }
  }
  // [FACE-PHOTO-1] Its own uploader. It shares /upload/public with the gallery
  // photos, but is stored in attrs and never added to cover_media — putting it
  // through the cover path would publish the creator's face on their listing,
  // which is the one thing this control promises not to do.
  async function onUploadFace(files: FileList | null) {
    const file = files?.[0];
    if (!file || !draft.id) return;
    setUploading(true);
    setError(null);
    try {
      const token = await getActiveToken();
      if (!token) { setError('Please sign in again to upload your photo.'); return; }
      const mime = inferImageMime(file);
      if (!mime) { setError('Photos only, please.'); return; }
      if (file.size > MAX_BYTES) { setError('That photo is too large (max 8 MB).'); return; }
      const res = await withTrace(() => fetch(`${API_BASE}/upload/public`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'x-content-type': mime, 'x-file-name': file.name, 'x-app': 'avatok' },
        body: file,
      }));
      if (!res.ok) { setError(`Couldn't upload that photo (${res.status}).`); return; }
      const body = await res.json() as { url?: string };
      if (!body.url) { setError('Upload finished but no photo came back. Try again.'); return; }
      patch({ face_photo: body.url });
      await request(`/api/listings/${encodeURIComponent(draft.id)}`, {
        method: 'PUT', auth: token, body: { attrs: buildAttrs({ ...draft, face_photo: body.url }) },
      });
      capture('listing_face_upload', { outcome: 'ok' });
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not upload that photo.');
      capture('listing_face_upload', { outcome: 'error' });
    } finally { setUploading(false); }
  }

  async function onRemoveCover(url: string) {
    if (!draft.id) return;
    const next = draft.cover_media.filter((c) => c.url !== url);
    patch({ cover_media: next });
    try {
      const token = await getActiveToken();
      await request(`/api/listings/${encodeURIComponent(draft.id)}`, { method: 'PUT', auth: token, body: { cover_media: next } });
    } catch { setError('Could not remove that photo.'); }
  }

  // [LIST-SUBMIT-REVIEW-1] Replaces the old direct-publish call. Publishing now
  // requires admin approval (worker/src/routes/admin_listings.ts), so the creator's
  // wizard only ever sends a draft INTO the review queue — POST /publish 409s for
  // anything that isn't already `approved` and is no longer reachable from here.
  async function onSubmitForReview() {
    if (publishing || !draft.id) return;
    setPublishing(true); setError(null); setGate(null);
    const ok = await saveDraft(7);
    if (!ok) { setPublishing(false); return; }
    try {
      const token = await getActiveToken();
      const r = await withTrace(() => request<{ status?: string }>(`/api/listings/${encodeURIComponent(draft.id!)}/submit`, { method: 'POST', auth: token }));
      capture('listing_submit_review', {
        outcome: 'ok', status: r.status ?? 'pending_review', kind: draft.kind,
        price: draft.free_entry ? 0 : Number(draft.price) || 0, free_entry: draft.free_entry,
      });
      // [LIST-EMBED-1] Inside the app the destination is the NATIVE My listings
      // screen (the card there reads "Review pending"), not the web dashboard —
      // navigating the WebView to /dashboard would leave the creator on a
      // chrome-less page with no way back into the app.
      if (isEmbedded()) { embedNotifySubmitted(draft.id); return; }
      window.location.href = `/dashboard/listings?submitted=${encodeURIComponent(draft.id!)}`;
    } catch (e) {
      if (e instanceof ApiError) {
        // The liveness/KYC gate responses DO carry a top-level `error`, so the
        // resolved code (which prefers body.code/reason first) still matches them.
        const code = apiErrorCode(e);
        if (isLivenessGate(code)) setGate('liveness');
        if (isKycGate(code)) setGate('kyc');
        const body = e.body && typeof e.body === 'object' ? (e.body as Record<string, unknown>) : null;
        setError(listingErrorMessage(code, body?.detail, body?.message));
      } else setError('Could not submit. Try again.');
      capture('listing_submit_review', {
        outcome: 'error', status: e instanceof ApiError ? e.status : 0,
        reason: e instanceof ApiError ? apiErrorCode(e) : (e instanceof Error ? e.message : 'unknown'), kind: draft.kind,
        price: draft.free_entry ? 0 : Number(draft.price) || 0, free_entry: draft.free_entry,
      });
    } finally { setPublishing(false); }
  }

  const checks = useMemo(() => publishReadiness(draft), [draft]);
  // [LIST-SUBMIT-REVIEW-1] `status !== 'draft'` used to stand in for "published",
  // which made a `pending_review` or `rejected` listing render "This listing is
  // published." — both are very much not. Each state now gets its own explicit flag.
  const published = draft.status === 'published' || draft.status === 'live' || draft.status === 'completed';
  const pendingReview = draft.status === 'pending_review';
  const approvedAwaitingPublish = draft.status === 'approved';
  const rejected = draft.status === 'rejected';
  const publicHref = draft.id ? `/l/${encodeURIComponent(draft.id)}` : null;

  if (loading) return <div className="font-body font-bold text-inkSoft">Loading…</div>;

  return (
    <div className="flex flex-col gap-6 pb-32 sm:pb-24">
      {/* [LIST-RESPONSIVE-1 2026-09-05] Stepper, two shapes.

          Eight pills reading "1. TYPE … 8. PREVIEW" wrap to four rows on a
          360px phone and push the first field below the fold, so on narrow
          screens this collapses to the line every mobile form uses — where you
          are, out of how many, and the name of the step — with Back/Next in the
          sticky bar doing the navigating. The full pill row (which doubles as a
          jump-to-step control) returns at `sm`, where it fits on one or two
          rows. */}
      <div className="sm:hidden">
        <div className="flex items-baseline gap-2">
          <span className="font-mono font-bold uppercase text-[13px] tracking-[0.1em] text-inkMute">
            Step {step + 1} of {STEP_LABELS.length}
          </span>
          {saving && <span className="font-mono font-bold uppercase text-[13px] tracking-[0.1em] text-inkSoft">· Saving…</span>}
        </div>
        <h2 className="mt-0.5 font-display font-semibold text-[24px] leading-tight text-ink">{STEP_LABELS[step]}</h2>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full border-zine border-ink bg-paper2">
          <div className="h-full bg-lime transition-[width] duration-200"
            style={{ width: `${((step + 1) / STEP_LABELS.length) * 100}%` }} />
        </div>
      </div>
      <div className="hidden flex-wrap items-center gap-1.5 sm:flex">
        {STEP_LABELS.map((label, i) => (
          <button key={label} type="button" disabled={i > step && !draft.id}
            onClick={() => { if (i <= step || draft.id) setStep(i as StepIndex); }}
            className={['rounded-full border-zine border-ink px-2.5 py-1 font-mono font-bold uppercase text-[10px] tracking-[0.06em]',
              i === step ? 'bg-lime text-ink' : i < step ? 'bg-card text-ink' : 'bg-paper2 text-inkMute'].join(' ')}>
            {i + 1}. {label}
          </button>
        ))}
        {/* [LIST-WIZ-PERF-1] The step already advanced — this pill is the only
            sign a background save is still in flight. */}
        {saving && (
          <span className="ml-1 rounded-full border-zine border-ink bg-paper2 px-2.5 py-1 font-mono font-bold uppercase text-[10px] tracking-[0.06em] text-inkSoft">
            Saving…
          </span>
        )}
      </div>

      <div className="w-full max-w-2xl">
        {step === 0 && <Step1Type draft={draft} patch={patch} err={fieldErr} freeEntryLocked={freeEntryLocked} />}
        {step === 1 && (
          <Step2Pitch
            draft={draft} patch={patch} err={fieldErr} categories={categories} creator={creatorInfo}
            conferenceEnabled={conferenceEnabled}
            aiAssisted={aiAssisted}
            onAssisted={(f: CopyField) => setAiAssisted((a) => ({ ...a, [f]: true }))}
            onSkipAi={() => setAiAssisted({ title: true, blurb: true, description: true })}
          />
        )}
        {step === 2 && <Step3Money draft={draft} patch={patch} err={fieldErr} />}
        {step === 3 && <Step4Time draft={draft} patch={patch} err={fieldErr} />}
        {step === 4 && <Step5HowItWorks draft={draft} patch={patch} />}
        {step === 5 && <Step6HouseRules draft={draft} patch={patch} />}
        {step === 6 && <Step7Photos draft={draft} patch={patch} err={fieldErr} onUpload={onUpload} onRemoveCover={onRemoveCover} uploading={uploading} onUploadFace={onUploadFace} />}
        {step === 7 && (
          <Step8Preview
            draft={draft} checks={checks} onSubmitForReview={onSubmitForReview} publishing={publishing}
            published={published} pendingReview={pendingReview} approvedAwaitingPublish={approvedAwaitingPublish} rejected={rejected}
            publicHref={publicHref} error={error} creator={creatorInfo}
          />
        )}
      </div>

      {step < 7 && error && <p className="max-w-2xl font-body font-bold text-[14px] text-coral">⚠ {error}</p>}

      {gate && (
        <Card fillClassName="bg-paper2" className="max-w-2xl">
          <p className="font-body font-bold text-[13px] text-inkSoft">
            {gate === 'liveness' ? 'This takes about a minute with your camera.' : 'This is a one-time identity check before you can sell sessions.'}
          </p>
          <a href="/dashboard/identity" className="mt-2 inline-block font-body font-bold text-[14px] text-blueInk underline">Verify now</a>
        </Card>
      )}

      {/* Sticky bottom nav */}
      {step < 7 && (
        /* [LIST-RESPONSIVE-1] `pb-[env(safe-area-inset-bottom)]` keeps the
           primary action clear of the iPhone home indicator and of Android's
           gesture bar in the app WebView, where there is no browser chrome
           below this bar to absorb it. The buttons also stretch to fill the row
           on a phone — a 90px "Next" floating at the right edge of a 360px bar
           is a small target for a thumb. */
        <div className="fixed inset-x-0 bottom-0 z-10 border-t-zine border-ink bg-paper px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            {step > 0 && <Button variant="ghost" label="Back" onClick={back} className="shrink-0" />}
            <div className="hidden flex-1 sm:block" />
            {/* [LIST-WIZ-PERF-1] No `loading` spinner here on purpose — next()
                advances the step immediately; the "Saving…" pill by the
                stepper is the only in-flight indicator now. */}
            <Button variant="lime" label={step === 0 ? 'Next' : 'Save and continue'} onClick={next}
              className="flex-1 sm:flex-none" />
          </div>
        </div>
      )}
    </div>
  );
}

export default ListingWizard;
