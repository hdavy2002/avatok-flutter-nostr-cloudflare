/* Prices — [ADMIN2-MOVE 2026-09-26] Saa Thum's "starting from" prices in the Admin 2 shell.
 * Same logic and API as islands/admin/AdminPricing.tsx (PRICING-1), restyled as a painted rate board:
 *   GET /api/pricing (public, edge-cached 60 s → cache-busted here)
 *   PUT /api/admin/pricing {havan_from, puja_from, rituals}
 * Ritual articles refresh from GET /api/pricing in the browser and the share-card renderer
 * reads it per request, so Save is the whole job: no rebuild, no deploy. */
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Save, Search } from 'lucide-react';
import { request, ApiError } from '../../lib/apiClient';
import { capture, captureException } from '../../lib/analytics';
import { rituals } from '../../lib/ritualGuides';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { toast } from '../../components/ui/sonner';
import { istDateTime, errMessage } from './adminApi';
import { DesiCard, DesiChip, DesiEmpty } from './desi';
import { ErrorBox, ListSkeleton, adminCall } from './peopleKit';

type Pricing = { currency: 'INR'; havan_from: number | null; puja_from: number | null; rituals: Record<string, number>; updated_at: number | null };

const toInput = (v: number | null | undefined) => (v == null ? '' : String(v));
const digits = (v: string) => v.replace(/[^\d]/g, '').slice(0, 7);

export default function Prices() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [havan, setHavan] = useState('');
  const [puja, setPuja] = useState('');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [dirty, setDirty] = useState(false);

  const apply = (p: Pricing) => {
    setHavan(toInput(p.havan_from)); setPuja(toInput(p.puja_from));
    setOverrides(Object.fromEntries(Object.entries(p.rituals ?? {}).map(([k, v]) => [k, String(v)])));
    setUpdatedAt(p.updated_at ?? null); setDirty(false);
  };

  const load = async () => {
    setLoading(true); setLoadError(null);
    try {
      // Cache-busted: /api/pricing is edge-cached 60 s and an admin must see the saved value.
      apply(await request<Pricing>('/api/pricing', { query: { cb: String(Date.now()) } }));
    } catch (e) {
      captureException(e, { where: 'admin2_prices_load' });
      setLoadError('Could not load the current prices.');
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rituals.filter((r) => !q || r.title.toLowerCase().includes(q) || r.slug.includes(q));
  }, [filter]);
  const overrideCount = Object.values(overrides).filter((v) => v.trim() !== '').length;

  async function save() {
    setSaving(true);
    try {
      const body = {
        havan_from: havan.trim() === '' ? null : Number(havan),
        puja_from: puja.trim() === '' ? null : Number(puja),
        rituals: Object.fromEntries(Object.entries(overrides).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, Number(v)])),
      };
      const r = await adminCall<{ ok: boolean; pricing: Pricing; changed: string[] }>('/api/admin/pricing', { method: 'PUT', body });
      apply(r.pricing);
      capture('admin_pricing_saved', { changed: r.changed.join(','), havan_from: r.pricing.havan_from, puja_from: r.pricing.puja_from });
      if (r.changed.length) toast.success('Prices saved', { description: 'Articles and share cards show the new prices within a minute.' });
      else toast('Nothing changed.');
    } catch (e) {
      toast.error(e instanceof ApiError ? errMessage(e, e.error) : 'Could not save the prices.');
    } finally { setSaving(false); }
  }

  if (loading) return <ListSkeleton rows={4} />;
  if (loadError) return <ErrorBox message={loadError} onRetry={() => void load()} />;

  const tagInput = 'h-12 min-h-11 rounded-2xl border-2 border-[#e9c98d] bg-white text-right font-["Nunito"] text-[length:var(--fs-body,16px)] font-black tabular-nums text-[var(--a-plum,#4a1747)] shadow-none focus-visible:border-[var(--a-plum,#4a1747)] focus-visible:ring-2 focus-visible:ring-[var(--a-rani,#d81b72)]';

  return (
    <div className="hf-admin-operations hfa-stack pb-24">
      <DesiCard tone="saffron" corner="marigold" title="Starting-from prices" note="Shown as “starting from ₹…” on every ritual article and on the WhatsApp share card. Leave a box empty to show no price.">
        <div className="grid gap-[clamp(12px,1.2vw,20px)] sm:grid-cols-2">
          {([
            ['price-havan', 'Open havans: starting from (₹)', havan, '111', (v: string) => setHavan(v), '#fff1d6'],
            ['price-puja', 'Private pujas: starting from (₹)', puja, 'Empty = no price shown', (v: string) => setPuja(v), '#ffe6ef'],
          ] as const).map(([id, text, val, ph, setter, tint]) => (
            <div key={id} className="relative rounded-[24px] border-2 border-dashed border-[#3b1600]/40 p-4 pl-12 shadow-[0_10px_24px_-14px_rgba(59,22,0,.6)]" style={{ background: tint }}>
              <span aria-hidden className="absolute left-4 top-5 h-5 w-5 rounded-full border-2 border-[#3b1600]/50 bg-[#ea9a3a]" />
              <Label htmlFor={id} className="mb-2 block text-[length:var(--fs-small,14px)] font-bold text-[#3b1600]">{text}</Label>
              <Input id={id} inputMode="numeric" value={val} placeholder={ph} onChange={(e) => { setter(digits(e.target.value)); setDirty(true); }} className={tagInput} />
            </div>
          ))}
        </div>
      </DesiCard>

      <DesiCard
        tone="cream" pattern="dots" corner="jasmine"
        title={<span className="inline-flex flex-wrap items-center gap-2">Price for one ritual {overrideCount > 0 && <DesiChip tone="gold">{overrideCount} set</DesiChip>}</span>}
        note="Optional. Empty uses the havan or puja price above."
        action={
          <div className="relative w-full sm:w-72">
            <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--a-rani,#d81b72)]" />
            <Input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search rituals" aria-label="Search rituals"
              className="h-11 min-h-11 rounded-full border-[1.5px] border-[var(--a-line,#f1e3d6)] bg-white pl-10 font-semibold shadow-none focus-visible:ring-2 focus-visible:ring-[var(--a-rani,#d81b72)]" />
          </div>
        }
      >
        {shown.length === 0 ? <DesiEmpty text={<>No ritual matches “{filter}”.</>} /> : (
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-[clamp(10px,1vw,16px)] p-0">
            {shown.map((r) => {
              const floor = r.type === 'havan' ? havan : puja;
              const havanTag = r.type === 'havan';
              return (
                <li
                  key={r.slug}
                  className="relative grid grid-cols-[minmax(0,1fr)_8.5rem] items-center gap-3 rounded-[20px] border-2 py-3 pl-11 pr-3 shadow-[0_8px_20px_-14px_rgba(74,23,71,.5)]"
                  style={{ background: havanTag ? 'linear-gradient(135deg,#fff6dc,#ffe8bd)' : 'linear-gradient(135deg,#fff0e0,#ffd7b8)', borderColor: havanTag ? '#e9c98d' : '#f0b27a' }}
                >
                  <span aria-hidden className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-[#b45309]/50 bg-[#fffaf3]" />
                  <div className="min-w-0">
                    <div className="font-['Nunito'] font-extrabold leading-snug text-[var(--a-ink,#2b1530)] [overflow-wrap:anywhere]">{r.title}</div>
                    <DesiChip tone={havanTag ? 'gold' : 'rani'} className="mt-1 uppercase">{r.type}</DesiChip>
                  </div>
                  <Input inputMode="numeric" aria-label={`Price for ${r.title}`} value={overrides[r.slug] ?? ''} placeholder={floor ? `₹${floor}` : 'No price'}
                    onChange={(e) => { setOverrides((o) => ({ ...o, [r.slug]: digits(e.target.value) })); setDirty(true); }} className={tagInput} />
                </li>
              );
            })}
          </ul>
        )}
      </DesiCard>

      {/* Sticky save bar: always reachable on a phone. */}
      <div className="sticky bottom-[calc(var(--dash-tabbar-h,0px)+12px)] z-10 flex flex-wrap items-center gap-3 rounded-full bg-[linear-gradient(120deg,#4a1747,#7a2470)] p-2 pl-3 shadow-[0_14px_30px_-12px_rgba(74,23,71,.7)] sm:bottom-4">
        <button type="button" className="hfa-btn gold" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {saving ? 'Saving…' : 'Save prices'}
        </button>
        <span className="text-[length:var(--fs-small,14px)] font-bold text-white">
          {dirty ? 'Unsaved changes' : updatedAt ? `Last changed ${istDateTime(updatedAt)}` : 'Not saved yet'}
        </span>
      </div>
    </div>
  );
}
