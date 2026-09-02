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
import { listingErrorMessage, isKycGate, isLivenessGate } from '../../../lib/listingErrors';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { IslandBoundary } from '../../../components/IslandBoundary';
import { capture, withTrace } from '../../../lib/analytics';
import { emptyDraft, STEP_LABELS } from './types';
import type { ListingDraft, StepIndex, DraftSlot } from './types';
import { bodyForSave, validateStep, publishReadiness, epochToLocal } from './wizardLogic';
import { defaultsFor } from '../../../lib/listingDefaults';
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
    kind,
    free_entry: Boolean(l.free_entry),
    content_free_cap_tokens: attrs.content_free_cap_tokens != null ? String(attrs.content_free_cap_tokens) : '',
    schedule_mode: l.schedule_mode || 'fixed_date',
    title: l.title ?? '',
    blurb: l.blurb ?? '',
    description: l.description ?? '',
    category: l.category ?? '',
    vibe_tags: Array.isArray(l.vibe_tags) ? l.vibe_tags : [],
    spoken_lang: typeof l.spoken_lang === 'string' && l.spoken_lang ? l.spoken_lang.split(',').filter(Boolean) : [],
    price: l.price != null ? String(l.price) : '',
    billing_unit: l.billing_unit || 'session',
    timezone: l.timezone || 'Asia/Kolkata',
    starts_at: epochToLocal(l.starts_at),
    duration_min: l.duration_min || 60,
    recurrence_days: Array.isArray(l.recurrence_days) ? l.recurrence_days : [],
    recurrence_time: l.recurrence_time || '18:00',
    response_time_min: l.response_time_min != null ? String(l.response_time_min) : '',
    max_per_booking: l.max_per_booking ?? 4,
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
    video_url: l.video_url ?? '',
    location: l.location ?? '',
    adults_only: Boolean(l.adults_only),
    commercial_refund_window_hours: attrs.commercial_refund_window_hours ?? 24,
    commercial_cancellation_window_hours: attrs.commercial_cancellation_window_hours ?? 24,
    commercial_reschedule_allowed: attrs.commercial_reschedule_allowed ?? true,
    commercial_booking_notice_hours: attrs.commercial_booking_notice_hours ?? 6,
  };
}

export function ListingWizard({ startAtPublish = false }: { startAtPublish?: boolean }) {
  const [draft, setDraft] = useState<ListingDraft>(() => emptyDraft());
  const [step, setStep] = useState<StepIndex>(startAtPublish ? 7 : 0);
  const [loading, setLoading] = useState(startAtPublish);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<FieldErr>({ field: null, message: null });
  const [gate, setGate] = useState<'liveness' | 'kyc' | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [slotsSupported, setSlotsSupported] = useState<boolean | null>(null);
  const [slotBusy, setSlotBusy] = useState(false);
  const [categories, setCategories] = useState<{ id: string; label: string; emoji?: string | null }[]>([]);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [repeatWeeks, setRepeatWeeks] = useState(4);
  const [repeating, setRepeating] = useState(false);
  const stepStartRef = useRef<number>(Date.now());

  function patch(p: Partial<ListingDraft>) { setDraft((d) => ({ ...d, ...p })); setFieldErr({ field: null, message: null }); }

  // categories — same source publishListing validates against, so nothing
  // picked here can be rejected at publish for not existing.
  useEffect(() => {
    void (async () => {
      try {
        const r = await request<{ categories?: typeof categories }>('/api/explore/categories');
        setCategories(r.categories ?? []);
      } catch { /* field stays empty; server refuses rather than silently defaulting */ }
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
      } catch { setError('Could not load this listing.'); }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    stepStartRef.current = Date.now();
    capture('listing_step_view', { step: STEP_LABELS[step] });
  }, [step]);

  const isLive = draft.kind === 'live_event';
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

  async function saveDraft(currentStep: StepIndex): Promise<boolean> {
    setBusy(true); setError(null);
    const includeAttrs = draft.id !== null || currentStep >= 1;
    const includePolicy = currentStep >= 6;
    const body = bodyForSave(draft, { includeAttrs, includePolicy });
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
      if (!id) { setError('Could not save the draft. Try again.'); return false; }
      if (id !== draft.id) setDraft((d) => ({ ...d, id }));
      capture('listing_save', { outcome: 'ok', status: 200, step: STEP_LABELS[currentStep] });
      capture('listing_step_complete', { step: STEP_LABELS[currentStep], ms: Date.now() - stepStartRef.current });
      return true;
    } catch (e) {
      const msg = e instanceof ApiError ? listingErrorMessage(e.error, (e.body as { detail?: unknown } | null)?.detail) : 'Could not save. Try again.';
      const field = e instanceof ApiError && e.body && typeof e.body === 'object' && 'field' in (e.body as any) ? String((e.body as any).field) : null;
      setError(msg);
      if (field) setFieldErr({ field, message: msg });
      capture('listing_field_error', { field: field ?? 'unknown', reason: e instanceof ApiError ? e.error : 'network' });
      capture('listing_save', {
        outcome: 'error', status: e instanceof ApiError ? e.status : 0,
        reason: e instanceof ApiError ? e.error : (e instanceof Error ? e.message : 'unknown'), step: STEP_LABELS[currentStep],
      });
      return false;
    } finally { setBusy(false); }
  }

  async function saveEarlyBirdAndPromo() {
    if (!draft.id) return;
    const pct = Number(draft.early_bird_pct);
    const token = await getActiveToken();
    if (draft.early_bird_pct && pct >= 1 && pct <= 100) {
      try { await request(`/api/listings/${encodeURIComponent(draft.id)}/promotions`, { method: 'POST', auth: token, body: { kind: 'early_bird', pct_off: pct } }); }
      catch { /* best-effort — the main save already succeeded */ }
    }
    if (draft.promo_code) {
      const codePct = pct >= 1 && pct <= 100 ? pct : 10;
      try { await request(`/api/listings/${encodeURIComponent(draft.id)}/promotions`, { method: 'POST', auth: token, body: { kind: 'promo_code', pct_off: codePct, code: draft.promo_code } }); }
      catch { /* best-effort */ }
    }
  }

  async function next() {
    if (busy) return;
    const problem = validateStep(draft, step);
    if (problem) {
      setFieldErr({ field: problem.field, message: problem.message });
      setError(problem.message);
      capture('listing_field_error', { field: problem.field, step: STEP_LABELS[step] });
      return;
    }
    // Steps 0 (Type) and 1 (Pitch) collect locally; the draft is created the
    // moment Pitch completes (spec: "create draft after step 2").
    if (step === 0) { setStep(1); return; }
    const ok = await saveDraft(step);
    if (!ok) return;
    if (step === 2) await saveEarlyBirdAndPromo();
    if (step < 7) setStep((s) => (s + 1) as StepIndex);
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
  async function onRemoveCover(url: string) {
    if (!draft.id) return;
    const next = draft.cover_media.filter((c) => c.url !== url);
    patch({ cover_media: next });
    try {
      const token = await getActiveToken();
      await request(`/api/listings/${encodeURIComponent(draft.id)}`, { method: 'PUT', auth: token, body: { cover_media: next } });
    } catch { setError('Could not remove that photo.'); }
  }

  // ── slots — [LIST-SLOTS-1], dark behind listingSlotsEnabled; a 503 means
  // "coming soon", never an error the creator needs to see. ─────────────────
  async function onAddSlot(s: Omit<DraftSlot, 'id'>) {
    if (!draft.id || slotBusy) return;
    setSlotBusy(true);
    try {
      const token = await getActiveToken();
      const r = await request<{ slot?: { id: string } }>(`/api/listings/${encodeURIComponent(draft.id)}/slots`, {
        method: 'POST', auth: token, body: { starts_at: s.starts_at, duration_min: s.duration_min, label: s.label || undefined, capacity: s.capacity },
      });
      setSlotsSupported(true);
      patch({ slots: [...draft.slots, { ...s, id: r.slot?.id }] });
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) setSlotsSupported(false);
      else setError('Could not add that slot.');
    } finally { setSlotBusy(false); }
  }
  async function onRemoveSlot(id: string) {
    try {
      const token = await getActiveToken();
      await request(`/api/slots/${encodeURIComponent(id)}`, { method: 'DELETE', auth: token });
      patch({ slots: draft.slots.filter((s) => s.id !== id) });
    } catch { setError('Could not remove that slot.'); }
  }

  async function onPublish() {
    if (publishing || !draft.id) return;
    setPublishing(true); setError(null); setGate(null);
    const ok = await saveDraft(7);
    if (!ok) { setPublishing(false); return; }
    try {
      const token = await getActiveToken();
      await withTrace(() => request(`/api/listings/${encodeURIComponent(draft.id!)}/publish`, { method: 'POST', auth: token }));
      capture('listing_publish', { outcome: 'ok', status: 200, kind: draft.kind, price: draft.free_entry ? 0 : Number(draft.price) || 0, free_entry: draft.free_entry });
      window.location.href = `/dashboard/listings?published=${encodeURIComponent(draft.id!)}`;
    } catch (e) {
      if (e instanceof ApiError) {
        if (isLivenessGate(e.error)) setGate('liveness');
        if (isKycGate(e.error)) setGate('kyc');
        setError(listingErrorMessage(e.error, (e.body as { detail?: unknown } | null)?.detail));
      } else setError('Could not publish. Try again.');
      capture('listing_publish', {
        outcome: 'error', status: e instanceof ApiError ? e.status : 0,
        reason: e instanceof ApiError ? e.error : (e instanceof Error ? e.message : 'unknown'), kind: draft.kind,
      });
    } finally { setPublishing(false); }
  }

  async function onRepeat() {
    if (repeating || !draft.id) return;
    setRepeating(true); setError(null);
    try {
      const token = await getActiveToken();
      const r = await withTrace(() => request<{ listing_ids?: string[] }>(`/api/listings/${encodeURIComponent(draft.id!)}/repeat`, { method: 'POST', auth: token, body: { weeks: repeatWeeks } }));
      const n = r.listing_ids?.length ?? 0;
      capture('listing_repeat', { weeks: repeatWeeks, outcome: 'ok' });
      window.location.href = `/dashboard/listings?repeated=${n}`;
    } catch {
      setError('Could not make the copies. Try again.');
      capture('listing_repeat', { weeks: repeatWeeks, outcome: 'error' });
    } finally { setRepeating(false); }
  }

  const checks = useMemo(() => publishReadiness(draft), [draft]);
  const ready = checks.every((c) => c.ok);
  const published = Boolean(draft.status && draft.status !== 'draft');
  const publicHref = draft.id ? `/l/${encodeURIComponent(draft.id)}` : null;

  if (loading) return <div className="font-body font-bold text-inkSoft">Loading…</div>;

  return (
    <div className="flex flex-col gap-6 pb-24">
      {/* Stepper */}
      <div className="flex flex-wrap gap-1.5">
        {STEP_LABELS.map((label, i) => (
          <button key={label} type="button" disabled={i > step && !draft.id}
            onClick={() => { if (i <= step || draft.id) setStep(i as StepIndex); }}
            className={['rounded-full border-zine border-ink px-2.5 py-1 font-mono font-bold uppercase text-[10px] tracking-[0.06em]',
              i === step ? 'bg-lime text-ink' : i < step ? 'bg-card text-ink' : 'bg-paper2 text-inkMute'].join(' ')}>
            {i + 1}. {label}
          </button>
        ))}
      </div>

      <div className="max-w-2xl">
        {step === 0 && <Step1Type draft={draft} patch={patch} err={fieldErr} />}
        {step === 1 && <Step2Pitch draft={draft} patch={patch} err={fieldErr} categories={categories} />}
        {step === 2 && <Step3Money draft={draft} patch={patch} err={fieldErr} />}
        {step === 3 && <Step4Time draft={draft} patch={patch} err={fieldErr} slotsSupported={slotsSupported} onAddSlot={onAddSlot} onRemoveSlot={onRemoveSlot} slotBusy={slotBusy} />}
        {step === 4 && <Step5HowItWorks draft={draft} patch={patch} />}
        {step === 5 && <Step6HouseRules draft={draft} patch={patch} />}
        {step === 6 && <Step7Photos draft={draft} patch={patch} err={fieldErr} onUpload={onUpload} onRemoveCover={onRemoveCover} uploading={uploading} />}
        {step === 7 && (
          <Step8Preview
            draft={draft} checks={checks} ready={ready} onPublish={onPublish} publishing={publishing}
            published={published} publicHref={publicHref} error={error}
            repeatOpen={repeatOpen} setRepeatOpen={setRepeatOpen} repeatWeeks={repeatWeeks} setRepeatWeeks={setRepeatWeeks}
            onRepeat={onRepeat} repeating={repeating} isLive={isLive}
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
        <div className="fixed inset-x-0 bottom-0 z-10 border-t-zine border-ink bg-paper px-4 py-3">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            {step > 0 && <Button variant="ghost" label="Back" onClick={back} />}
            <div className="flex-1" />
            <Button variant="lime" label={step === 0 ? 'Next' : 'Save and continue'} loading={busy} onClick={next} />
          </div>
        </div>
      )}
    </div>
  );
}

export default ListingWizard;
