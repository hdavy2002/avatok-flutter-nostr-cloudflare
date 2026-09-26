/* Prices — [ADMIN2-MOVE 2026-09-26] Saa Thum's "starting from" prices in the Admin 2 shell.
 * Same logic and API as islands/admin/AdminPricing.tsx (PRICING-1), restyled:
 *   GET /api/pricing (public, edge-cached 60 s → cache-busted here)
 *   PUT /api/admin/pricing {havan_from, puja_from, rituals}
 * Ritual articles refresh from GET /api/pricing in the browser and the share-card renderer
 * reads it per request, so Save is the whole job: no rebuild, no deploy. */
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Save, Search } from 'lucide-react';
import { request, ApiError } from '../../lib/apiClient';
import { capture, captureException } from '../../lib/analytics';
import { rituals } from '../../lib/ritualGuides';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { toast } from '../../components/ui/sonner';
import { istDateTime, errMessage } from './adminApi';
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

  return (
    <div className="space-y-5 pb-24">
      <section className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6">
        <h2 className="font-dash text-[20px] font-bold text-grand-teal">Starting-from prices</h2>
        <p className="mt-1 max-w-2xl text-[14px] font-semibold leading-relaxed text-muted-foreground">
          Shown as “starting from ₹…” on every ritual article and on the WhatsApp share card. Leave a box empty to show no price.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="price-havan" className="text-[13px] font-bold">Open havans: starting from (₹)</Label>
            <Input id="price-havan" inputMode="numeric" value={havan} placeholder="111" onChange={(e) => { setHavan(digits(e.target.value)); setDirty(true); }} className="text-[16px] font-bold" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="price-puja" className="text-[13px] font-bold">Private pujas: starting from (₹)</Label>
            <Input id="price-puja" inputMode="numeric" value={puja} placeholder="Empty = no price shown" onChange={(e) => { setPuja(digits(e.target.value)); setDirty(true); }} className="text-[16px] font-bold" />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="flex items-center gap-2 font-dash text-[20px] font-bold text-grand-teal">Price for one ritual {overrideCount > 0 && <Badge variant="accent">{overrideCount} set</Badge>}</h2>
            <p className="mt-1 text-[14px] font-semibold text-muted-foreground">Optional. Empty uses the havan or puja price above.</p>
          </div>
          <div className="relative sm:w-72">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search rituals" aria-label="Search rituals" className="pl-9" />
          </div>
        </div>
        <ul className="mt-4 divide-y divide-border/40 overflow-hidden rounded-lg border border-border/60">
          {shown.map((r) => {
            const floor = r.type === 'havan' ? havan : puja;
            return (
              <li key={r.slug} className="grid grid-cols-[1fr_8.5rem] items-center gap-3 bg-card px-3 py-2.5 hover:bg-muted/30">
                <div className="min-w-0">
                  <div className="truncate text-[14.5px] font-bold text-foreground">{r.title}</div>
                  <div className="text-[11.5px] font-extrabold uppercase tracking-[0.08em] text-muted-foreground">{r.type}</div>
                </div>
                <Input inputMode="numeric" aria-label={`Price for ${r.title}`} value={overrides[r.slug] ?? ''} placeholder={floor ? `₹${floor}` : 'No price'}
                  onChange={(e) => { setOverrides((o) => ({ ...o, [r.slug]: digits(e.target.value) })); setDirty(true); }} className="text-right font-bold tabular-nums" />
              </li>
            );
          })}
          {shown.length === 0 && <li className="px-3 py-6 text-center text-[14px] font-semibold text-muted-foreground">No ritual matches “{filter}”.</li>}
        </ul>
      </section>

      {/* Sticky save bar: always reachable on a phone. */}
      <div className="sticky bottom-[calc(var(--dash-tabbar-h,0px)+12px)] z-10 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur sm:bottom-4">
        <Button variant="accent" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} {saving ? 'Saving…' : 'Save prices'}
        </Button>
        <span className="text-[13px] font-semibold text-muted-foreground">
          {dirty ? 'Unsaved changes' : updatedAt ? `Last changed ${istDateTime(updatedAt)}` : 'Not saved yet'}
        </span>
      </div>
    </div>
  );
}
