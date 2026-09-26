/* EventForm — [ADMIN2-EVENTS 2026-09-26] /admin/events/new and /admin/events/[id].
 * Contract: Specs/SPEC-2026-09-26-ADMIN-2.md ("Events"). API: worker/src/routes/admin2_events.ts.
 *
 *  - One form for create and edit. Edit sends ONLY the fields that changed (the server
 *    diffs again and logs what actually changed against the admin's id).
 *  - "What's missing before publish" is the server's listing_blockers result for the
 *    saved event — the same list publish enforces — never a browser copy of the rules.
 *  - Publish = save, then approve + publish in one server action (no review loop).
 *  - Cancel refunds every open booking first (server rule); the dialog says so.
 *  - The YouTube link uses the existing admin route (PUT /api/admin/listings/:id/youtube).
 *  - Telemetry: admin2_event_saved {action}; failures -> captureException.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft, Ban, CalendarDays, CircleAlert, CircleCheck, Clock, Copy, ExternalLink, ImagePlus, IndianRupee,
  Loader2, MonitorPlay, Save, Send, Sparkles, Ticket, Trash2, Undo2, Upload, Users,
} from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Calendar } from '../../components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { toast } from '../../components/ui/sonner';
import { fmtDuration, fmtIstDateTime, listingImage, youtubeThumb, ErrorState, Shimmer } from '../../components/dash2/shared';
import { ApiError, adminApi, errMessage, formatPaise } from './adminApi';
import {
  DURATION_PRESETS, TIME_SLOTS, dateOfYmd, eventsPath, istTodayYmd, looksLikeYoutube, saveYoutube, statusMeta,
  timeLabel, uploadCover, ymdOf, type Blocker, type EventDetailResponse, type EventsMeta,
} from './eventsApi';

/* ── form model ─────────────────────────────────────────────────────────── */

interface FormState {
  title: string;
  category: string;
  deity: string;
  blurb: string;
  description: string;
  cover_url: string;
  start_date: string;
  start_time: string;
  duration_min: string;
  price_rupees: string;
  capacity: string;
  performed_by: string;
  youtube_url: string;
}

const EMPTY: FormState = {
  title: '', category: '', deity: '', blurb: '', description: '', cover_url: '', start_date: '', start_time: '06:00',
  duration_min: '60', price_rupees: '', capacity: '', performed_by: 'Saa Thum', youtube_url: '',
};

function fromDetail(d: EventDetailResponse): FormState {
  const e = d.event;
  return {
    title: e.title ?? '',
    category: e.category ?? '',
    deity: e.deity ?? '',
    blurb: e.blurb ?? '',
    description: e.description ?? '',
    cover_url: e.manual_cover_url ?? '',
    start_date: e.start_ist?.date ?? '',
    start_time: e.start_ist?.time ?? '',
    duration_min: e.duration_min ? String(e.duration_min) : '',
    price_rupees: e.price_rupees ? String(e.price_rupees) : '',
    capacity: e.capacity ? String(e.capacity) : '',
    performed_by: e.performed_by ?? '',
    youtube_url: d.youtube?.url ?? '',
  };
}

/** The request body for the worker, from the fields that differ from `base` (all of them on create). */
function bodyOf(f: FormState, base: FormState | null): Record<string, unknown> {
  const changed = (k: keyof FormState) => !base || f[k] !== base[k];
  const out: Record<string, unknown> = {};
  if (changed('title')) out.title = f.title;
  if (changed('category')) out.category = f.category;
  if (changed('deity')) out.deity = f.deity;
  if (changed('blurb')) out.blurb = f.blurb;
  if (changed('description')) out.description = f.description;
  if (changed('cover_url')) out.cover_url = f.cover_url || null;
  if (changed('start_date') || changed('start_time')) {
    if (f.start_date || !base) { out.start_date = f.start_date; out.start_time = f.start_date ? f.start_time : ''; }
    else { out.start_date = ''; out.start_time = ''; }
  }
  if (changed('duration_min')) out.duration_min = f.duration_min === '' ? null : Number(f.duration_min);
  if (changed('price_rupees') && f.price_rupees !== '') out.price_rupees = Number(f.price_rupees);
  if (changed('capacity')) out.capacity = f.capacity === '' ? null : Number(f.capacity);
  if (changed('performed_by')) out.performed_by = f.performed_by;
  if (!base) {
    // Create: omit empties the server treats as "not set yet".
    for (const k of ['deity', 'blurb', 'description', 'performed_by'] as const) if (!f[k]) delete out[k];
    if (!f.start_date) { delete out.start_date; delete out.start_time; }
    if (f.capacity === '') delete out.capacity;
  }
  return out;
}

const FIELD_OF_BLOCKER: Record<string, keyof FormState> = {
  title: 'title', category: 'category', starts_at: 'start_date', duration_min: 'duration_min', price: 'price_rupees',
  performed_by: 'performed_by', description: 'description', blurb: 'blurb', cover_media: 'cover_url', cover_url: 'cover_url',
  capacity: 'capacity',
};

type Busy = null | 'save' | 'publish' | 'unpublish' | 'cancel' | 'upload' | 'poster';

/* ── component ──────────────────────────────────────────────────────────── */

export default function EventForm({ eventId }: { eventId?: string }) {
  const [id, setId] = useState<string | undefined>(eventId);
  const [meta, setMeta] = useState<EventsMeta | null>(null);
  const [detail, setDetail] = useState<EventDetailResponse | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [base, setBase] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(!!eventId);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [banner, setBanner] = useState<{ tone: 'error' | 'ok'; text: string; blockers?: Blocker[] } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const refs = useRef<Partial<Record<keyof FormState, HTMLElement | null>>>({});
  const fileRef = useRef<HTMLInputElement | null>(null);

  const status = detail?.event.status ?? 'draft';
  const isPublic = status === 'published' || status === 'live';
  const isClosed = status === 'cancelled' || status === 'completed';
  const scheduleLocked = isPublic;

  useEffect(() => {
    adminApi<EventsMeta>(eventsPath(undefined, 'meta')).then(setMeta).catch((e) => {
      captureException(e, { where: 'admin2_event_form_meta' });
    });
  }, []);

  const load = useCallback(async (targetId: string) => {
    setLoadError(null);
    try {
      const d = await adminApi<EventDetailResponse>(eventsPath(targetId));
      setDetail(d);
      const f = fromDetail(d);
      setForm(f); setBase(f);
    } catch (e) {
      captureException(e, { where: 'admin2_event_form_load' });
      setLoadError(e instanceof ApiError && e.status === 404 ? 'This event does not exist (or was deleted).' : errMessage(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (eventId) void load(eventId); }, [eventId, load]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((s) => ({ ...s, [k]: v }));
    setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));
  };

  const dirtyKeys = useMemo(() => (Object.keys(form) as (keyof FormState)[]).filter((k) => !base || form[k] !== base[k]), [form, base]);
  const dirty = !base || dirtyKeys.length > 0;

  function applyDetail(d: EventDetailResponse, keepYoutube?: string) {
    setDetail(d);
    const f = fromDetail(d);
    if (keepYoutube !== undefined) f.youtube_url = keepYoutube;
    setForm(f); setBase(f);
  }

  function focusField(k: keyof FormState) {
    const el = refs.current[k];
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); (el as HTMLInputElement).focus?.(); }
  }

  function showError(e: unknown, action: string) {
    const body = e instanceof ApiError ? (e.body as Record<string, any> | undefined) : undefined;
    const field = body?.field ? FIELD_OF_BLOCKER[String(body.field)] : undefined;
    const msg = errMessage(e);
    if (field) { setErrors((x) => ({ ...x, [field]: msg })); focusField(field); }
    setBanner({ tone: 'error', text: msg, blockers: Array.isArray(body?.blockers) ? body!.blockers : undefined });
    toast.error(msg);
    if (!(e instanceof ApiError) || e.status >= 500) captureException(e, { where: `admin2_event_${action}` });
    capture('admin2_event_saved', { action, ok: false, error: e instanceof ApiError ? e.error : 'network', listing_id: id ?? null });
  }

  /** Client-side sanity for the obvious cases; the server is the authority. */
  function precheck(): boolean {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (form.title.trim().length < 3) e.title = 'Give the event a title.';
    if (!form.category) e.category = 'Pick a category.';
    if (form.youtube_url.trim() && !looksLikeYoutube(form.youtube_url)) e.youtube_url = 'That is not a YouTube link.';
    const min = meta?.min_price_rupees ?? 49;
    if (form.price_rupees !== '' && (!Number.isInteger(Number(form.price_rupees)) || Number(form.price_rupees) < min)) e.price_rupees = `Price must be a whole number, at least ₹${min}.`;
    setErrors(e);
    const first = Object.keys(e)[0] as keyof FormState | undefined;
    if (first) { focusField(first); return false; }
    return true;
  }

  /** Save (create or edit) + YouTube link. Returns the event id, or null on failure. */
  async function save(action: 'create' | 'update' | 'publish'): Promise<string | null> {
    if (!precheck()) return null;
    let currentId = id;
    const ytChanged = (base?.youtube_url ?? '') !== form.youtube_url.trim();
    try {
      if (!currentId) {
        const r = await adminApi<EventDetailResponse & { id: string }>(eventsPath(), { method: 'POST', body: bodyOf(form, null) });
        currentId = r.id;
        setId(r.id);
        window.history.replaceState(null, '', `/admin/events/${encodeURIComponent(r.id)}`);
        applyDetail(r, form.youtube_url);
        capture('admin2_event_saved', { action: 'create', ok: true, listing_id: r.id });
      } else if (dirtyKeys.some((k) => k !== 'youtube_url')) {
        const r = await adminApi<EventDetailResponse>(eventsPath(currentId), { method: 'PUT', body: bodyOf(form, base) });
        applyDetail(r, form.youtube_url);
        if (action !== 'publish') capture('admin2_event_saved', { action: 'update', ok: true, listing_id: currentId, fields: dirtyKeys.join(',') });
      }
      if (ytChanged && currentId) {
        await saveYoutube(currentId, form.youtube_url.trim());
        setBase((b) => (b ? { ...b, youtube_url: form.youtube_url.trim() } : b));
        capture('admin2_event_saved', { action: 'youtube', ok: true, listing_id: currentId, cleared: !form.youtube_url.trim() });
        const d = await adminApi<EventDetailResponse>(eventsPath(currentId));
        applyDetail(d);
      }
      return currentId ?? null;
    } catch (e) {
      showError(e, action);
      return null;
    }
  }

  async function onSave() {
    setBusy('save'); setBanner(null);
    const ok = await save(id ? 'update' : 'create');
    if (ok) { setBanner({ tone: 'ok', text: 'Saved.' }); toast.success('Saved'); }
    setBusy(null);
  }

  async function onPublish() {
    setBusy('publish'); setBanner(null);
    const saved = dirty || !id ? await save('publish') : id;
    if (!saved) { setBusy(null); return; }
    try {
      const r = await adminApi<EventDetailResponse>(eventsPath(saved, 'publish'), { method: 'POST' });
      applyDetail(r);
      setBanner({ tone: 'ok', text: 'Published. Customers can book it now.' });
      toast.success('Published', { description: 'Customers can book it now.' });
      capture('admin2_event_saved', { action: 'publish', ok: true, listing_id: saved });
    } catch (e) {
      showError(e, 'publish');
      void load(saved);
    } finally { setBusy(null); }
  }

  async function onUnpublish() {
    if (!id) return;
    setBusy('unpublish'); setBanner(null);
    try {
      const r = await adminApi<EventDetailResponse>(eventsPath(id, 'unpublish'), { method: 'POST' });
      applyDetail(r);
      setBanner({ tone: 'ok', text: 'Unpublished. It is back in Drafts.' });
      toast.success('Unpublished');
      capture('admin2_event_saved', { action: 'unpublish', ok: true, listing_id: id });
    } catch (e) { showError(e, 'unpublish'); } finally { setBusy(null); }
  }

  async function onCancel() {
    if (!id) return;
    setBusy('cancel'); setBanner(null);
    try {
      const r = await adminApi<{ ok: boolean; refunds: { scanned: number; refunded: number; review_pending: number; no_refund: number } }>(
        eventsPath(id, 'cancel'), { method: 'POST', body: { confirm: true } },
      );
      const rf = r.refunds;
      const text = rf.scanned
        ? `Cancelled. ${rf.refunded} refunded${rf.review_pending ? `, ${rf.review_pending} waiting for a manual refund (see Refunds)` : ''}${rf.no_refund ? `, ${rf.no_refund} with no refund due` : ''}.`
        : 'Cancelled. Nobody had booked.';
      setBanner({ tone: 'ok', text });
      toast.success('Event cancelled');
      capture('admin2_event_saved', { action: 'cancel', ok: true, listing_id: id, refunded: rf.refunded, review_pending: rf.review_pending });
      await load(id);
    } catch (e) { showError(e, 'cancel'); } finally { setBusy(null); setConfirmCancel(false); }
  }

  async function onUpload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setBusy('upload');
    try {
      const url = await uploadCover(file);
      set('cover_url', url);
      toast.success('Image uploaded', { description: 'Save to keep it.' });
      capture('admin2_event_cover_upload', { ok: true });
    } catch (e) {
      const msg = e instanceof Error && !(e instanceof ApiError) ? e.message : errMessage(e);
      setErrors((x) => ({ ...x, cover_url: msg }));
      captureException(e, { where: 'admin2_event_cover_upload' });
      capture('admin2_event_cover_upload', { ok: false });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function onPoster(action: 'generate' | 'keep') {
    let target = id;
    if (!target || dirty) { target = (await save('update')) ?? undefined; if (!target) return; }
    setBusy('poster'); setBanner(null);
    try {
      const r = await adminApi<EventDetailResponse>(eventsPath(target, 'poster'), { method: 'POST', body: { action }, timeoutMs: 120_000 });
      applyDetail(r);
      toast.success(action === 'generate' ? 'AI poster ready — keep it or upload your own.' : 'AI poster kept.');
      capture('admin2_event_saved', { action: action === 'generate' ? 'poster_generate' : 'poster_keep', ok: true, listing_id: target });
    } catch (e) { showError(e, action === 'generate' ? 'poster_generate' : 'poster_keep'); } finally { setBusy(null); }
  }

  async function copyLink() {
    if (!id) return;
    const url = `${window.location.origin}/book/${encodeURIComponent(id)}`;
    try { await navigator.clipboard.writeText(url); toast.success('Link copied', { description: url }); }
    catch { toast.error('Could not copy the link.'); }
  }

  /* ── render ── */

  if (loading) {
    return (
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]" aria-busy="true">
        <div className="flex flex-col gap-4">{[0, 1, 2].map((i) => <Shimmer key={i} className="h-40 w-full rounded-xl" />)}</div>
        <Shimmer className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (loadError) return <ErrorState message={loadError} onRetry={() => { setLoading(true); void load(eventId!); }} />;

  const ev = detail?.event;
  const st = statusMeta(status, ev?.tab);
  const coverPreview = form.cover_url || ev?.ai_poster_url || '';
  const usingAi = !form.cover_url && !!ev?.ai_poster_url;
  const blockers = detail?.blockers ?? [];
  const posterPlan = detail?.poster_plan;
  const minPrice = meta?.min_price_rupees ?? 49;
  const disabled = isClosed || busy !== null;
  const ytId = detail?.youtube?.video_id;

  return (
    <div className="flex flex-col gap-5 pb-28 lg:pb-0">
      {/* Header strip */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <a href="/admin/events" className="inline-flex items-center gap-1.5 text-[14px] font-bold text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> All events
        </a>
        {id && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={st.variant}>{st.label}</Badge>
            <Button variant="ghost" size="sm" onClick={() => void copyLink()}><Copy /> Copy link</Button>
            <Button asChild variant="ghost" size="sm"><a href={`/book/${encodeURIComponent(id)}`} target="_blank" rel="noopener"><ExternalLink /> View on site</a></Button>
            <Button asChild variant="ghost" size="sm"><a href={`/admin/bookings?event=${encodeURIComponent(id)}`}><Ticket /> Bookings{ev ? ` (${ev.seats_booked})` : ''}</a></Button>
          </div>
        )}
      </div>

      {banner && (
        <div role={banner.tone === 'error' ? 'alert' : 'status'}
          className={cn('rounded-xl border px-4 py-3 text-[14px] font-semibold',
            banner.tone === 'error' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-accent/40 bg-accent/10 text-foreground')}>
          <p className="flex items-start gap-2">{banner.tone === 'error' ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" />}{banner.text}</p>
          {banner.blockers && banner.blockers.length > 1 && (
            <ul className="mt-2 list-disc pl-10 text-[13px]">{banner.blockers.map((b) => <li key={b.code}>{b.message}</li>)}</ul>
          )}
        </div>
      )}

      {isClosed && (
        <p className="rounded-xl border border-border bg-muted px-4 py-3 text-[14px] font-semibold text-muted-foreground">
          This event is {status === 'cancelled' ? 'cancelled' : 'over'}. It can't be edited.
        </p>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ── Main column ── */}
        <div className="flex flex-col gap-5">
          <Section title="The event" subtitle="What customers see on the booking page.">
            <Field label="Title" htmlFor="ev-title" error={errors.title} hint={`${form.title.length}/${meta?.limits.titleMax ?? 120}`}>
              <Input id="ev-title" ref={(el) => { refs.current.title = el; }} value={form.title} maxLength={meta?.limits.titleMax ?? 120}
                disabled={disabled} onChange={(e) => set('title', e.target.value)} placeholder="Maha Mrityunjaya Havan" aria-invalid={!!errors.title} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Category" error={errors.category}>
                <Select value={form.category || undefined} onValueChange={(v) => set('category', v)} disabled={disabled}>
                  <SelectTrigger ref={(el) => { refs.current.category = el; }} aria-invalid={!!errors.category} aria-label="Category">
                    <SelectValue placeholder="Pick a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {(meta?.categories ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
                    {form.category && meta && !meta.categories.some((c) => c.id === form.category) && (
                      <SelectItem value={form.category}>{ev?.category_label ?? form.category} (inactive)</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Deity" htmlFor="ev-deity" error={errors.deity} hint="Optional">
                <Input id="ev-deity" list="ev-deity-list" value={form.deity} maxLength={meta?.limits.deityMax ?? 60} disabled={disabled}
                  onChange={(e) => set('deity', e.target.value)} placeholder="Shiva" />
                <datalist id="ev-deity-list">{(meta?.deity_suggestions ?? []).map((d) => <option key={d} value={d} />)}</datalist>
              </Field>
            </div>
            <Field label="Short description" htmlFor="ev-blurb" error={errors.blurb} hint={`${form.blurb.length}/${meta?.limits.blurbMax ?? 120}`}>
              <Input id="ev-blurb" ref={(el) => { refs.current.blurb = el; }} value={form.blurb} maxLength={meta?.limits.blurbMax ?? 120} disabled={disabled}
                onChange={(e) => set('blurb', e.target.value)} placeholder="One line for the card" />
            </Field>
            <Field label="Long description" htmlFor="ev-desc" error={errors.description} hint="What happens, what the devotee receives, how to prepare.">
              <textarea id="ev-desc" ref={(el) => { refs.current.description = el; }} rows={6} value={form.description}
                maxLength={meta?.limits.descriptionMax ?? 6000} disabled={disabled} onChange={(e) => set('description', e.target.value)}
                className="flex min-h-[140px] w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm" />
            </Field>
            <Field label="Performed by" htmlFor="ev-perf" error={errors.performed_by} hint="Required before publishing — the priest or team customers are booking.">
              <Input id="ev-perf" ref={(el) => { refs.current.performed_by = el; }} value={form.performed_by} maxLength={meta?.limits.performedByMax ?? 80}
                disabled={disabled} onChange={(e) => set('performed_by', e.target.value)} placeholder="Pandit Ramesh Sharma, Haridwar" />
            </Field>
          </Section>

          <Section title="Cover image" subtitle="Upload a photo, or generate the AI poster and keep it.">
            <div ref={(el) => { refs.current.cover_url = el; }} className="flex flex-col gap-4 sm:flex-row">
              <div className="relative aspect-[4/5] w-full overflow-hidden rounded-lg border border-border/70 bg-muted sm:w-48">
                {coverPreview ? <img src={listingImage(coverPreview, 480) ?? coverPreview} alt="Cover preview" className="h-full w-full object-cover" />
                  : <span className="flex h-full w-full flex-col items-center justify-center gap-2 text-[13px] font-bold text-muted-foreground"><ImagePlus className="h-7 w-7" />No image yet</span>}
                {usingAi && <Badge variant="secondary" className="absolute left-2 top-2"><Sparkles className="h-3 w-3" /> AI poster{ev?.poster?.status === 'approved' ? '' : ' · not kept'}</Badge>}
                {(busy === 'upload' || busy === 'poster') && (
                  <span className="absolute inset-0 flex items-center justify-center bg-card/70"><Loader2 className="h-6 w-6 animate-spin text-primary" /></span>
                )}
              </div>
              <div className="flex flex-1 flex-col gap-2">
                <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" id="ev-cover-file"
                  onChange={(e) => void onUpload(e.target.files)} disabled={disabled} />
                <Button type="button" variant="outline" disabled={disabled} onClick={() => fileRef.current?.click()}>
                  <Upload /> {form.cover_url ? 'Replace image' : 'Upload image'}
                </Button>
                {form.cover_url && (
                  <Button type="button" variant="ghost" disabled={disabled} onClick={() => set('cover_url', '')}><Trash2 /> Remove uploaded image</Button>
                )}
                {!form.cover_url && (
                  <>
                    <Button type="button" variant="outline" disabled={disabled || !form.title.trim() || !form.category} onClick={() => void onPoster('generate')}>
                      <Sparkles /> {ev?.ai_poster_url ? 'Generate a new AI poster' : 'Generate AI poster'}
                    </Button>
                    {ev?.poster?.status === 'draft' && (
                      <Button type="button" disabled={disabled} onClick={() => void onPoster('keep')}><CircleCheck /> Keep this poster</Button>
                    )}
                  </>
                )}
                <p className="text-[12px] font-semibold text-muted-foreground">JPG, PNG or WebP, up to 8 MB. Portrait works best. The AI poster takes up to a minute.</p>
                {ev?.poster?.status === 'failed' && <p className="text-[13px] font-semibold text-destructive">The AI poster failed{ev.poster.error ? `: ${ev.poster.error}` : ''}. Try again or upload an image.</p>}
                {errors.cover_url && <p className="text-[13px] font-semibold text-destructive">{errors.cover_url}</p>}
              </div>
            </div>
          </Section>

          <Section title="When" subtitle="Indian Standard Time.">
            {scheduleLocked && (
              <p className="rounded-md bg-muted px-3 py-2 text-[13px] font-semibold text-muted-foreground">
                A published event's date and time can't change — people booked for that time. Cancel it and create a new one instead.
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Date" error={errors.start_date}>
                <Popover open={dateOpen} onOpenChange={setDateOpen}>
                  <PopoverTrigger asChild>
                    <Button ref={(el) => { refs.current.start_date = el; }} type="button" variant="outline" disabled={disabled || scheduleLocked}
                      className={cn('w-full justify-start font-semibold', !form.start_date && 'text-muted-foreground')} aria-invalid={!!errors.start_date}>
                      <CalendarDays /> {form.start_date ? fmtYmd(form.start_date) : 'Pick a date'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar mode="single" selected={dateOfYmd(form.start_date)} defaultMonth={dateOfYmd(form.start_date)}
                      disabled={{ before: dateOfYmd(istTodayYmd())! }}
                      onSelect={(d) => { if (d) { set('start_date', ymdOf(d)); setDateOpen(false); } }} initialFocus />
                  </PopoverContent>
                </Popover>
              </Field>
              <Field label="Start time (IST)" error={errors.start_time}>
                <Select value={form.start_time || undefined} onValueChange={(v) => set('start_time', v)} disabled={disabled || scheduleLocked}>
                  <SelectTrigger aria-label="Start time"><Clock className="h-4 w-4 text-muted-foreground" /><SelectValue placeholder="Pick a time" /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {form.start_time && !TIME_SLOTS.includes(form.start_time) && <SelectItem value={form.start_time}>{timeLabel(form.start_time)}</SelectItem>}
                    {TIME_SLOTS.map((t) => <SelectItem key={t} value={t}>{timeLabel(t)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field label="Duration" error={errors.duration_min} hint={form.duration_min ? fmtDuration(Number(form.duration_min)) : `${meta?.duration.min ?? 5}–${meta?.duration.max ?? 480} minutes`}>
              <div className="flex flex-wrap items-center gap-2">
                {DURATION_PRESETS.map((m) => (
                  <Button key={m} type="button" size="sm" variant={form.duration_min === String(m) ? 'default' : 'outline'} disabled={disabled || scheduleLocked}
                    onClick={() => set('duration_min', String(m))}>{fmtDuration(m)}</Button>
                ))}
                <Input ref={(el) => { refs.current.duration_min = el; }} type="number" inputMode="numeric" min={5} max={480} className="w-28"
                  value={form.duration_min} disabled={disabled || scheduleLocked} onChange={(e) => set('duration_min', e.target.value)} aria-label="Duration in minutes" />
              </div>
            </Field>
          </Section>

          <Section title="Price and seats">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Price (₹)" htmlFor="ev-price" error={errors.price_rupees} hint={`Per booking. At least ₹${minPrice}.`}>
                <div className="relative">
                  <IndianRupee className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="ev-price" ref={(el) => { refs.current.price_rupees = el; }} type="number" inputMode="numeric" min={minPrice} step={1} className="pl-9"
                    value={form.price_rupees} disabled={disabled} onChange={(e) => set('price_rupees', e.target.value)} placeholder="501" aria-invalid={!!errors.price_rupees} />
                </div>
              </Field>
              <Field label="Capacity" htmlFor="ev-cap" error={errors.capacity} hint="Optional. Empty = no limit.">
                <div className="relative">
                  <Users className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="ev-cap" ref={(el) => { refs.current.capacity = el; }} type="number" inputMode="numeric" min={1} step={1} className="pl-9"
                    value={form.capacity} disabled={disabled} onChange={(e) => set('capacity', e.target.value)} placeholder="No limit" />
                </div>
              </Field>
            </div>
          </Section>

          <Section title="YouTube live link" subtitle="Create an UNLISTED live stream on YouTube and paste its link. The same video serves the live event and its replay; only people who paid can see it.">
            <Field label="Unlisted YouTube link" htmlFor="ev-yt" error={errors.youtube_url}>
              <Input id="ev-yt" ref={(el) => { refs.current.youtube_url = el; }} inputMode="url" value={form.youtube_url} disabled={disabled}
                onChange={(e) => set('youtube_url', e.target.value)} placeholder="https://youtube.com/live/…" aria-invalid={!!errors.youtube_url} />
            </Field>
            {ytId && form.youtube_url === (base?.youtube_url ?? '') && (
              <div className="flex items-center gap-3">
                <img src={youtubeThumb(ytId)} alt="Video thumbnail" className="aspect-video w-40 rounded-md border border-border/70 object-cover" />
                <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-accent"><MonitorPlay className="h-4 w-4" /> Linked · id {ytId}</span>
              </div>
            )}
          </Section>
        </div>

        {/* ── Side column: readiness + actions ── */}
        <aside className="flex flex-col gap-4 lg:sticky lg:top-6">
          <div className="dash-surface rounded-xl border border-border/70 bg-card p-4">
            <h2 className="font-dash text-[17px] font-bold text-grand-teal">Before publishing</h2>
            {!id ? (
              <p className="mt-2 text-[14px] font-semibold text-muted-foreground">Save the event to check what's still missing.</p>
            ) : isClosed ? (
              <p className="mt-2 text-[14px] font-semibold text-muted-foreground">Nothing to do.</p>
            ) : isPublic ? (
              <p className="mt-2 flex items-center gap-2 text-[14px] font-semibold text-foreground"><CircleCheck className="h-4 w-4 text-accent" /> Live on the site and taking bookings.</p>
            ) : blockers.length === 0 && posterPlan?.kind !== 'needs_image' ? (
              <p className="mt-2 flex items-center gap-2 text-[14px] font-semibold text-foreground"><CircleCheck className="h-4 w-4 text-accent" /> Ready to publish.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {blockers.map((b) => {
                  const f = b.field ? FIELD_OF_BLOCKER[b.field] : undefined;
                  return (
                    <li key={b.code} className="flex items-start gap-2 text-[14px] font-semibold text-foreground">
                      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                      <span>{b.message}{f && <button type="button" className="ml-1 font-bold text-accent underline-offset-2 hover:underline" onClick={() => focusField(f)}>Fix</button>}</span>
                    </li>
                  );
                })}
                {posterPlan?.kind === 'needs_image' && (
                  <li className="flex items-start gap-2 text-[14px] font-semibold text-foreground">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <span>{posterPlan.message}</span>
                  </li>
                )}
              </ul>
            )}
            {id && dirty && !isClosed && <p className="mt-3 text-[12px] font-semibold text-muted-foreground">You have unsaved changes — this list is for the saved version.</p>}
          </div>

          {ev && (
            <div className="dash-surface rounded-xl border border-border/70 bg-card p-4 text-[14px] font-semibold">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                <dt className="text-muted-foreground">Starts</dt><dd className="text-foreground">{fmtIstDateTime(ev.starts_at)}</dd>
                <dt className="text-muted-foreground">Price</dt><dd className="text-foreground">{formatPaise(ev.price_paise)}</dd>
                <dt className="text-muted-foreground">Booked</dt><dd className="text-foreground">{ev.seats_booked}{ev.capacity ? ` of ${ev.capacity}` : ''}{ev.pending_payments ? ` · ${ev.pending_payments} paying` : ''}</dd>
                <dt className="text-muted-foreground">Video</dt><dd className="text-foreground">{ev.youtube_set ? 'Linked' : 'Not linked yet'}</dd>
              </dl>
            </div>
          )}

          {!isClosed && (
            <div className="fixed inset-x-0 bottom-[calc(var(--dash-tabbar-h,64px)+env(safe-area-inset-bottom,0px))] z-30 border-t border-border bg-card/95 p-3 backdrop-blur sm:bottom-0 sm:left-[var(--dash-rail-w,72px)] lg:static lg:z-auto lg:rounded-xl lg:border lg:bg-card lg:p-4 lg:backdrop-blur-none">
              <div className="mx-auto flex max-w-6xl flex-wrap gap-2 lg:flex-col">
                <Button variant="outline" className="flex-1" disabled={busy !== null || (!!id && !dirty)} onClick={() => void onSave()}>
                  {busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />} {isPublic ? 'Save changes' : 'Save draft'}
                </Button>
                {!isPublic ? (
                  <Button className="flex-1" disabled={busy !== null} onClick={() => void onPublish()}>
                    {busy === 'publish' ? <Loader2 className="animate-spin" /> : <Send />} Publish
                  </Button>
                ) : status === 'published' ? (
                  <Button variant="secondary" className="flex-1" disabled={busy !== null || (ev?.seats_booked ?? 0) > 0 || (ev?.pending_payments ?? 0) > 0}
                    title={(ev?.seats_booked ?? 0) > 0 ? 'People have booked — cancel instead' : undefined} onClick={() => void onUnpublish()}>
                    {busy === 'unpublish' ? <Loader2 className="animate-spin" /> : <Undo2 />} Unpublish
                  </Button>
                ) : null}
                {id && (isPublic || status === 'draft') && (
                  <Button variant="ghost" className="flex-1 text-destructive hover:bg-destructive/10" disabled={busy !== null} onClick={() => setConfirmCancel(true)}>
                    <Ban /> {status === 'draft' ? 'Discard draft' : 'Cancel event'}
                  </Button>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>

      <AlertDialog open={confirmCancel} onOpenChange={(o) => { if (busy !== 'cancel') setConfirmCancel(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{status === 'draft' ? 'Discard this draft?' : 'Cancel this event?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {status === 'draft'
                ? 'It moves to Cancelled. Nothing was sold.'
                : (ev?.seats_booked ?? 0) > 0
                  ? `${ev!.seats_booked} ${ev!.seats_booked === 1 ? 'person has' : 'people have'} booked. Every open booking is refunded first; any that need a manual UPI refund appear in Refunds. This can't be undone.`
                  : 'Nobody has booked yet. The event comes off the site. This can’t be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === 'cancel'}>Keep it</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={busy === 'cancel'}
              onClick={(e) => { e.preventDefault(); void onCancel(); }}>
              {busy === 'cancel' && <Loader2 className="animate-spin" />} {status === 'draft' ? 'Discard' : 'Cancel event'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ── small building blocks ─────────────────────────────────────────────── */

function fmtYmd(ymd: string): string {
  const d = dateOfYmd(ymd);
  return d ? d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : ymd;
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="dash-surface flex flex-col gap-4 rounded-xl border border-border/70 bg-card p-4 sm:p-5">
      <header>
        <h2 className="font-dash text-[18px] font-bold text-grand-teal">{title}</h2>
        {subtitle && <p className="mt-1 text-[13px] font-semibold text-muted-foreground">{subtitle}</p>}
      </header>
      {children}
    </section>
  );
}

function Field({ label, htmlFor, error, hint, children }: { label: string; htmlFor?: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={htmlFor} className="font-bold">{label}</Label>
        {hint && !error && <span className="text-[12px] font-semibold text-muted-foreground">{hint}</span>}
      </div>
      {children}
      {error && <p className="text-[13px] font-semibold text-destructive" role="alert">{error}</p>}
    </div>
  );
}
