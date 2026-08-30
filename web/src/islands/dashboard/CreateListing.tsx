/* CreateListing — create OR edit a listing on the web (app: listing create/edit).
 *
 * [LIST-WEB-FORM-1] This form used to collect FOUR fields — kind, title, one-liner,
 * price — while `publishListing` in the worker requires SEVEN things. So every listing
 * ever made on the web was a draft that could not be published:
 *
 *   title            ✓ collected
 *   category         ✗ never asked; the worker silently defaulted it to "teachers"
 *   ≥1 cover photo   ✗ no upload existed anywhere in web/  → see ListingPublish.tsx
 *   starts_at        ✗ live events only, required and must be in the future
 *   duration_min     ✗ live events only, 5–480
 *   capacity         ✗ consults only, exactly 1 / 10 / 20
 *   availability     ✗ consults only, set in AvaCalendar (linked from the publish screen)
 *
 * The SERVER was never the bottleneck: normFields() in worker/src/routes/listings.ts
 * already accepts 26 fields. This was a front-end gap, and the missing category default
 * meant creators were publishing under a category they never chose.
 *
 * Everything mirrored here is ALSO enforced server-side. The client checks exist to
 * spare a round trip, never to be the authority — see publishListing.
 *
 * Gated by RequireAccount. New: POST /api/listings (draft) → publish screen.
 * Edit (?id=): GET /api/listings/:id to prefill, PUT /api/listings/:id to save.
 * ?kind=live_event|consult preselects the type for a new listing.
 */
import { useEffect, useState } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import { listingErrorMessage } from '../../lib/listingErrors';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Card } from '../../components/Card';
import { RequireAccountInline } from '../auth/RequireAccount';

type Kind = 'live_event' | 'consult';
type Category = { id: string; label: string; emoji?: string | null };

const KINDS: { key: Kind; label: string; sub: string; chip: string }[] = [
  { key: 'live_event', label: 'Live event', sub: 'Broadcast to ticket holders', chip: '◐' },
  { key: 'consult', label: '1:1 consult', sub: 'Private video session', chip: '◑' },
];

/** Mirrors the worker's live_event bound: duration_min must be 5–480. */
const DURATIONS = [15, 30, 45, 60, 90, 120, 180];

/** Mirrors CAPACITIES in worker/src/routes/listings.ts — the worker rejects anything else. */
const CAPACITIES = [1, 10, 20];

const LANGS = ['Hindi', 'English', 'Bengali', 'Tamil', 'Telugu', 'Marathi', 'Gujarati', 'Punjabi', 'Urdu', 'Kannada', 'Malayalam'];

/** `<input type="datetime-local">` value → epoch ms. Returns null when unparseable. */
function localToEpoch(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Epoch ms → the `YYYY-MM-DDTHH:mm` shape datetime-local needs, in LOCAL time. */
function epochToLocal(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Form() {
  const [editId, setEditId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<Kind>('live_event');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [startsAt, setStartsAt] = useState('');
  const [durationMin, setDurationMin] = useState(60);
  const [capacity, setCapacity] = useState(1);
  const [langs, setLangs] = useState<string[]>([]);
  const [location, setLocation] = useState('');
  const [adultsOnly, setAdultsOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Categories come from the same table publishListing validates against
  // (`SELECT 1 FROM listing_categories WHERE id=?1 AND active=1`), so a category
  // picked here cannot be rejected at publish for not existing.
  useEffect(() => {
    void (async () => {
      try {
        const r = await request<{ categories?: Category[] }>('/api/explore/categories');
        setCategories(r.categories ?? []);
      } catch { /* the field stays empty and the server refuses — no silent default */ }
    })();
  }, []);

  useEffect(() => {
    let id: string | null = null; let k: string | null = null;
    try { const p = new URLSearchParams(location_search()); id = p.get('id'); k = p.get('kind'); } catch { /* */ }
    if (k === 'live_event' || k === 'consult') setKind(k);
    if (!id) return;
    setEditId(id); setLoading(true);
    void (async () => {
      try {
        const token = await getActiveToken();
        const l = await request<any>(`/api/listings/${encodeURIComponent(id!)}`, { auth: token });
        const data = l?.listing ?? l ?? {};
        if (data.kind === 'live' || data.kind === 'live_event') setKind('live_event');
        else if (data.kind === 'consult') setKind('consult');
        setTitle(data.title ?? '');
        setDescription(data.description ?? data.one_liner ?? '');
        setPrice(data.price != null ? String(data.price) : '');
        setCategory(data.category ?? '');
        setStartsAt(epochToLocal(data.starts_at));
        if (data.duration_min) setDurationMin(Number(data.duration_min));
        if (data.capacity) setCapacity(Number(data.capacity));
        if (typeof data.spoken_lang === 'string' && data.spoken_lang) setLangs(data.spoken_lang.split(',').filter(Boolean));
        setLocation(data.location ?? '');
        setAdultsOnly(Boolean(data.adults_only));
      } catch { setError('Could not load this listing to edit.'); }
      setLoading(false);
    })();
  }, []);

  /** Client mirror of the server's publish checks. The server is the authority. */
  function localProblem(): string | null {
    if (title.trim().length < 3) return 'Give your listing a title (at least 3 characters).';
    if (!category) return 'Pick a category.';
    if (kind === 'live_event') {
      const ms = localToEpoch(startsAt);
      if (ms === null) return 'Pick the date and time your event starts.';
      if (ms <= Date.now()) return 'The start time needs to be in the future.';
      if (durationMin < 5 || durationMin > 480) return 'Length must be between 5 minutes and 8 hours.';
    }
    if (kind === 'consult' && !CAPACITIES.includes(capacity)) return 'Pick how many people can book.';
    return null;
  }

  async function submit() {
    if (busy) return;
    const problem = localProblem();
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try {
      const token = await getActiveToken();
      const body: Record<string, unknown> = {
        kind,
        title: title.trim(),
        description: description.trim() || undefined,
        price: price ? Math.round(Number(price)) : 0,
        category,
        adults_only: adultsOnly,
        // Empty string would overwrite a real value on edit; undefined leaves it alone.
        spoken_lang: langs.length ? langs.join(',') : undefined,
        location: location.trim() || undefined,
      };
      if (kind === 'live_event') {
        body.starts_at = localToEpoch(startsAt);
        body.duration_min = durationMin;
      } else {
        body.capacity = capacity;
      }
      if (editId) {
        await request(`/api/listings/${encodeURIComponent(editId)}`, { method: 'PUT', auth: token, body });
        location_assign(`/dashboard/listings/publish?id=${encodeURIComponent(editId)}`);
      } else {
        const r = await request<{ listing_id?: string }>('/api/listings', { method: 'POST', auth: token, body });
        // Straight to the publish screen — the old flow dropped people on the listings
        // index with a draft they had no way to finish.
        if (r.listing_id) location_assign(`/dashboard/listings/publish?id=${encodeURIComponent(r.listing_id)}`);
        else setError('Could not create the draft. Try again.');
      }
    } catch (e) {
      setError(e instanceof ApiError
        ? listingErrorMessage(e.error, (e.body as { detail?: unknown } | null)?.detail)
        : 'Could not save. Try again.');
    } finally { setBusy(false); }
  }

  if (loading) return <div className="font-body font-bold text-inkSoft">Loading…</div>;

  const labelCls = 'mb-2 block font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft';
  const selectCls = 'w-full rounded-zineField border-zine border-ink bg-card px-3.5 py-4 font-body font-extrabold text-[18px] text-ink outline-none shadow-zine-sm';

  return (
    <div className="flex max-w-lg flex-col gap-5">
      <div>
        <span className={labelCls}>Type</span>
        <div className="grid grid-cols-2 gap-3">
          {KINDS.map((k) => (
            <button key={k.key} type="button" onClick={() => setKind(k.key)}
              className={['flex flex-col items-start gap-1 rounded-zine border-zine border-ink p-3 text-left shadow-zine-xs transition-transform duration-zine', kind === k.key ? 'bg-lime' : 'bg-card hover:-translate-y-[1px]'].join(' ')}>
              <span className="text-[20px]">{k.chip}</span>
              <span className="font-display font-semibold text-[15px] text-ink">{k.label}</span>
              <span className="font-body font-bold text-[12px] text-inkSoft">{k.sub}</span>
            </button>
          ))}
        </div>
      </div>

      <Field label="Title" placeholder="e.g. Friday night live cook-along" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Field label="One-liner" placeholder="What fans get" value={description} onChange={(e) => setDescription(e.target.value)} />
      <Field label="Price (Tokens)" inputMode="numeric" placeholder="0 = free" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9]/g, ''))} />

      <label className="block">
        <span className={labelCls}>Category</span>
        <select className={selectCls} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Choose one…</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.emoji ? `${c.emoji} ` : ''}{c.label}</option>
          ))}
        </select>
      </label>

      {kind === 'live_event' ? (
        <>
          <Field label="Starts" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          <label className="block">
            <span className={labelCls}>Length</span>
            <select className={selectCls} value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))}>
              {DURATIONS.map((d) => <option key={d} value={d}>{d < 60 ? `${d} minutes` : `${d / 60} hour${d === 60 ? '' : 's'}`}</option>)}
            </select>
          </label>
        </>
      ) : (
        <label className="block">
          <span className={labelCls}>How many can book</span>
          <select className={selectCls} value={capacity} onChange={(e) => setCapacity(Number(e.target.value))}>
            {CAPACITIES.map((c) => <option key={c} value={c}>{c === 1 ? 'Just one person (1:1)' : `Up to ${c} people`}</option>)}
          </select>
        </label>
      )}

      <div>
        <span className={labelCls}>Language</span>
        <div className="flex flex-wrap gap-2">
          {LANGS.map((l) => {
            const on = langs.includes(l);
            return (
              <button key={l} type="button"
                onClick={() => setLangs(on ? langs.filter((x) => x !== l) : [...langs, l])}
                className={['rounded-zineField border-zine border-ink px-3 py-2 font-body font-bold text-[13px] shadow-zine-xs', on ? 'bg-lime text-ink' : 'bg-card text-inkSoft'].join(' ')}>
                {l}
              </button>
            );
          })}
        </div>
      </div>

      <Field label="Location (optional)" placeholder="e.g. Mumbai" value={location} onChange={(e) => setLocation(e.target.value)} />

      <label className="flex items-center gap-3">
        <input type="checkbox" checked={adultsOnly} onChange={(e) => setAdultsOnly(e.target.checked)}
          className="h-5 w-5 rounded border-zine border-ink" />
        <span className="font-body font-bold text-[14px] text-ink">This is for adults only (18+)</span>
      </label>

      {error && <p className="font-body font-bold text-[14px] text-coral">⚠ {error}</p>}

      {!editId && (
        <Card fillClassName="bg-paper2">
          <p className="font-body font-bold text-[13px] text-inkSoft">
            This saves a <span className="text-ink">draft</span>. Next you&rsquo;ll add photos and publish.
          </p>
        </Card>
      )}

      <Button variant="lime" label={editId ? 'Save and continue' : 'Create draft'} loading={busy} onClick={submit} />
    </div>
  );
}

/* Indirection so the component never shadows `location` with its own state name —
 * this file has a `location` FIELD (the listing's city), and `location.href` inside
 * the same scope would silently read that string instead of the browser's location. */
function location_search(): string {
  return typeof window === 'undefined' ? '' : window.location.search;
}
function location_assign(href: string): void {
  if (typeof window !== 'undefined') window.location.href = href;
}

export function CreateListing() {
  // [LIST-WEB-FORM-1] Actually wrapped now. The file header and new.astro have both
  // claimed "Gated by RequireAccount" since this component was written, while the body
  // rendered <Form/> bare.
  return (
    <RequireAccountInline label="Create a listing">
      <Form />
    </RequireAccountInline>
  );
}

export default CreateListing;
