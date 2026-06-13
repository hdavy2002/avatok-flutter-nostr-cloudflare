/* CreateListing — create OR edit a listing on the web (app: listing create/edit).
 * Gated by RequireAccount. New: POST /api/listings (draft) → listings page.
 * Edit (?id=): GET /api/listings/:id to prefill, PUT /api/listings/:id to save.
 * ?kind=live_event|consult preselects the type for a new listing.
 *
 * The worker accepts kind = live_event | consult. Agent listings (AvaVoice/
 * AvaVision) are managed from their own studios.
 */
import { useEffect, useState } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Card } from '../../components/Card';

type Kind = 'live_event' | 'consult';

const KINDS: { key: Kind; label: string; sub: string; chip: string }[] = [
  { key: 'live_event', label: 'Live event', sub: 'Broadcast to ticket holders', chip: '◐' },
  { key: 'consult', label: '1:1 consult', sub: 'Private video session', chip: '◑' },
];

function Form() {
  const [editId, setEditId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<Kind>('live_event');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let id: string | null = null; let k: string | null = null;
    try { const p = new URLSearchParams(location.search); id = p.get('id'); k = p.get('kind'); } catch { /* */ }
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
        setDescription(data.description ?? '');
        setPrice(data.price != null ? String(data.price) : '');
      } catch { setError('Could not load this listing to edit.'); }
      setLoading(false);
    })();
  }, []);

  async function submit() {
    if (busy || title.trim().length < 3) return;
    setBusy(true); setError(null);
    try {
      const token = await getActiveToken();
      const body = { kind, title: title.trim(), description: description.trim() || undefined, price: price ? Math.round(Number(price)) : 0 };
      if (editId) {
        await request(`/api/listings/${encodeURIComponent(editId)}`, { method: 'PUT', auth: token, body });
        location.href = '/dashboard/listings';
      } else {
        const r = await request<{ listing_id?: string }>('/api/listings', { method: 'POST', auth: token, body });
        if (r.listing_id) location.href = `/dashboard/listings?created=${r.listing_id}`;
        else setError('Could not create the draft. Try again.');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not save. Try again.');
    } finally { setBusy(false); }
  }

  if (loading) return <div className="font-body font-bold text-inkSoft">Loading…</div>;

  return (
    <div className="flex max-w-lg flex-col gap-5">
      <div>
        <span className="mb-2 block font-mono font-bold uppercase text-[12px] tracking-[0.08em] text-inkSoft">Type</span>
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
      <Field label="Price (AvaCoins)" inputMode="numeric" placeholder="0 = free" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9]/g, ''))} />

      {error && <p className="font-body font-bold text-[14px] text-coral">⚠ {error}</p>}

      {!editId && (
        <Card fillClassName="bg-paper2">
          <p className="font-body font-bold text-[13px] text-inkSoft">
            This creates a <span className="text-ink">draft</span>. Next you'll add cover photos and publish —
            publishing verifies your identity (KYC) and, for live events, claims the time slot.
          </p>
        </Card>
      )}

      <Button variant="lime" label={editId ? 'Save changes' : 'Create draft'} loading={busy} disabled={title.trim().length < 3} onClick={submit} />
    </div>
  );
}

export function CreateListing() {
  return (
    
      <Form />
    
  );
}

export default CreateListing;
