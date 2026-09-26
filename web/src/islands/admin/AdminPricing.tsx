// [PRICING-1 2026-09-26] Admin screen for the "starting from" prices.
//
// Writes PUT /api/admin/pricing (worker/src/routes/pricing.ts). Ritual articles
// refresh their prices in the browser from GET /api/pricing, and the share-card
// renderer reads it per request — so Save here is the whole job: no rebuild, no
// deploy. Social apps (WhatsApp) keep their own copy of a card they already
// fetched, so an old share may show the old price for a while.
//
// Auth dance copied from AdminReviews.tsx (fresh Clerk token on 401) — required,
// a Clerk session JWT lives about a minute and this page is left open.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import { capture } from '../../lib/analytics';
import { Spinner } from '../../components/Spinner';
import { rituals } from '../../lib/ritualGuides';

type Pricing = {
  currency: 'INR';
  havan_from: number | null;
  puja_from: number | null;
  rituals: Record<string, number>;
  updated_at: number | null;
};

const field = 'w-full rounded-zine border-zine border-ink bg-card px-3 py-2 font-body text-[15px] font-bold text-ink';
const label = 'font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-inkSoft';

function toInput(v: number | null | undefined): string { return v == null ? '' : String(v); }

export default function AdminPricing() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [havan, setHavan] = useState('');
  const [puja, setPuja] = useState('');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [filter, setFilter] = useState('');

  const withAuth = useCallback(async <T,>(run: (token: string) => Promise<T>): Promise<T> => {
    const first = await getActiveToken();
    if (!first) throw new ApiError(401, 'Your session ended. Reload the page to sign in again.');
    try {
      return await run(first);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      const fresh = await getActiveToken(5000, { skipCache: true });
      if (!fresh || fresh === first) throw new ApiError(401, 'Your session ended. Reload the page to sign in again.');
      return run(fresh);
    }
  }, []);

  const apply = (p: Pricing) => {
    setHavan(toInput(p.havan_from));
    setPuja(toInput(p.puja_from));
    setOverrides(Object.fromEntries(Object.entries(p.rituals ?? {}).map(([k, v]) => [k, String(v)])));
    setUpdatedAt(p.updated_at ?? null);
  };

  useEffect(() => {
    (async () => {
      try {
        // Cache-busted: /api/pricing is edge-cached 60 s and an admin must see the saved value.
        apply(await request<Pricing>('/api/pricing', { query: { cb: String(Date.now()) } }));
      } catch {
        setError('Could not load the current prices.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rituals.filter((r) => !q || r.title.toLowerCase().includes(q) || r.slug.includes(q));
  }, [filter]);

  async function save() {
    setSaving(true); setError(null); setSaved(null);
    try {
      const body = {
        havan_from: havan.trim() === '' ? null : Number(havan),
        puja_from: puja.trim() === '' ? null : Number(puja),
        rituals: Object.fromEntries(Object.entries(overrides).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, Number(v)])),
      };
      const r = await withAuth((t) => request<{ ok: boolean; pricing: Pricing; changed: string[] }>('/api/admin/pricing', { method: 'PUT', auth: t, body }));
      apply(r.pricing);
      capture('admin_pricing_saved', { changed: r.changed.join(','), havan_from: r.pricing.havan_from, puja_from: r.pricing.puja_from });
      setSaved(r.changed.length ? 'Saved. Articles and share cards show the new prices within a minute.' : 'Nothing changed.');
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not save the prices.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="flex justify-center p-10"><Spinner /></div>;

  return (
    <div className="grid gap-6">
      <section className="rounded-zine border-zine border-ink bg-card p-6 shadow-zine-sm">
        <h2 className="font-display text-[24px] font-semibold text-ink">Starting-from prices</h2>
        <p className="mt-2 max-w-2xl font-body text-[15px] font-bold leading-relaxed text-inkSoft">
          Shown as “starting from ₹…” on every ritual article and on the WhatsApp share card. Leave a box empty to show no price.
        </p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="grid gap-2">
            <span className={label}>Open havans — starting from (₹)</span>
            <input className={field} inputMode="numeric" value={havan} onChange={(e) => setHavan(e.target.value.replace(/[^\d]/g, ''))} placeholder="111" />
          </label>
          <label className="grid gap-2">
            <span className={label}>Private pujas — starting from (₹)</span>
            <input className={field} inputMode="numeric" value={puja} onChange={(e) => setPuja(e.target.value.replace(/[^\d]/g, ''))} placeholder="empty = no price shown" />
          </label>
        </div>
      </section>

      <section className="rounded-zine border-zine border-ink bg-card p-6 shadow-zine-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="font-display text-[22px] font-semibold text-ink">Price for one ritual</h2>
            <p className="mt-1 font-body text-[14px] font-bold text-inkSoft">Optional. Empty uses the havan or puja price above.</p>
          </div>
          <input className={`${field} sm:max-w-xs`} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search rituals" />
        </div>
        <div className="mt-4 grid gap-2">
          {shown.map((r) => {
            const floor = r.type === 'havan' ? havan : puja;
            return (
              <div key={r.slug} className="grid grid-cols-[1fr_8.5rem] items-center gap-3 rounded-zine border-zine border-ink bg-paper2 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-body text-[15px] font-bold text-ink">{r.title}</div>
                  <div className="font-body text-[12px] font-bold uppercase tracking-[0.06em] text-inkSoft">{r.type}</div>
                </div>
                <input
                  className={field}
                  inputMode="numeric"
                  aria-label={`Price for ${r.title}`}
                  value={overrides[r.slug] ?? ''}
                  placeholder={floor ? `₹${floor}` : 'no price'}
                  onChange={(e) => setOverrides((o) => ({ ...o, [r.slug]: e.target.value.replace(/[^\d]/g, '') }))}
                />
              </div>
            );
          })}
        </div>
      </section>

      {error && <div role="alert" className="rounded-zine border-zine border-ink bg-coral p-4 font-body text-[14px] font-bold text-ink shadow-zine-sm">{error}</div>}
      {saved && <div role="status" className="rounded-zine border-zine border-ink bg-lime p-4 font-body text-[14px] font-bold text-ink shadow-zine-sm">{saved}</div>}

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-full border-zine border-ink bg-lime px-6 py-3 font-mono text-[14px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save prices'}
        </button>
        {updatedAt && <span className="font-body text-[13px] font-bold text-inkSoft">Last changed {new Date(updatedAt).toLocaleString()}</span>}
      </div>
    </div>
  );
}
