/* CreateListing — create a listing draft on the web (app: listing create).
 * Gated by RequireAccount. Creates a DRAFT via POST /api/listings, then sends the
 * creator to their listings to add photos & publish (publish enforces KYC + slot
 * claim server-side — MASTER §4 / worker listings.ts).
 *
 * The worker's create endpoint accepts kind = live_event | consult. Agent
 * listings (AvaVoice/AvaVision) are created from their own studios.
 */
import { useState } from 'react';
import { RequireAccount } from '../auth/RequireAccount';
import { getActiveToken } from '../../lib/clerk';
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
  const [kind, setKind] = useState<Kind>('live_event');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy || title.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getActiveToken();
      const r = await request<{ ok?: boolean; listing_id?: string }>('/api/listings', {
        method: 'POST',
        auth: token,
        body: {
          kind,
          title: title.trim(),
          description: description.trim() || undefined,
          price: price ? Math.round(Number(price)) : 0,
        },
      });
      if (r.listing_id) {
        location.href = `/dashboard/listings?created=${r.listing_id}`;
      } else {
        setError('Could not create the draft. Try again.');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not create the draft.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-lg flex-col gap-5">
      {/* Kind picker */}
      <div>
        <span className="mb-2 block font-mono font-bold uppercase text-[12px] tracking-[0.08em] text-inkSoft">Type</span>
        <div className="grid grid-cols-2 gap-3">
          {KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              onClick={() => setKind(k.key)}
              className={[
                'flex flex-col items-start gap-1 rounded-zine border-zine border-ink p-3 text-left shadow-zine-xs transition-transform duration-zine',
                kind === k.key ? 'bg-lime' : 'bg-card hover:-translate-y-[1px]',
              ].join(' ')}
            >
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

      <Card fillClassName="bg-paper2">
        <p className="font-body font-bold text-[13px] text-inkSoft">
          This creates a <span className="text-ink">draft</span>. Next you'll add cover photos and publish —
          publishing verifies your identity (KYC) and, for live events, claims the time slot.
        </p>
      </Card>

      <Button variant="lime" label="Create draft" loading={busy} disabled={title.trim().length < 3} onClick={submit} />
    </div>
  );
}

export function CreateListing() {
  return (
    <RequireAccount label="Creating a listing">
      <Form />
    </RequireAccount>
  );
}

export default CreateListing;
