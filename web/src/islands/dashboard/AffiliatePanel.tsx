/* AffiliatePanel — the affiliate pipeline on the web.
 *   GET  /api/affiliate/me     → { registered, code, status, link_url_base, totals }
 *   GET  /api/affiliate/links  → { links: [...] }  (headline stats per link)
 *   POST /api/affiliate/register → become an affiliate
 */
import { useEffect, useState } from 'react';
import { ClerkIsland, getActiveToken } from '../../lib/clerk';
import { request } from '../../lib/apiClient';
import { Spinner } from '../../components/Spinner';

type Totals = { lifetime_coins?: number; month_coins?: number; held_coins?: number; links?: number; referred_users?: number };
type Me = { registered?: boolean; code?: string; status?: string; link_url_base?: string; totals?: Totals };
type Link = { id: string; url?: string; clicks?: number; created_at?: number; bound_users?: number; purchases?: number; earned_coins?: number };

const usd = (c?: number) => `$${((c ?? 0) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className={`flex flex-col gap-1 rounded-zine border-zine border-ink ${tone} p-4 shadow-zine-sm`}>
      <span className="font-mono font-bold uppercase text-[10px] tracking-[0.08em] text-inkSoft">{label}</span>
      <span className="font-display font-semibold text-[26px] leading-none text-ink">{value}</span>
    </div>
  );
}

function Inner() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void (async () => { setToken(await getActiveToken()); setChecked(true); })(); }, []);
  useEffect(() => {
    if (!checked || !token) return;
    void (async () => {
      try { setMe(await request<Me>('/api/affiliate/me', { auth: token })); } catch { setMe({ registered: false }); }
      try { const r = await request<{ links?: Link[] }>('/api/affiliate/links', { auth: token }); setLinks(r.links ?? []); } catch { /* ignore */ }
    })();
  }, [token, checked]);

  async function registerNow() {
    if (!token) return; setBusy(true);
    try { await request('/api/affiliate/register', { method: 'POST', auth: token }); setMe(await request<Me>('/api/affiliate/me', { auth: token })); }
    catch { alert('Could not register — you may need a verified account first.'); }
    setBusy(false);
  }

  if (!checked) return <div className="flex items-center gap-3 p-8"><Spinner size={22} /></div>;
  if (token && me === null) return <div className="flex items-center gap-3 p-8"><Spinner size={22} /> <span className="font-body font-bold text-inkSoft">Loading…</span></div>;

  if (!token || !me?.registered) {
    return (
      <div className="flex flex-col items-start gap-4 rounded-zine border-zine border-ink bg-paper2 p-8 shadow-zine">
        <span className="flex h-12 w-12 items-center justify-center rounded-zine border-zine border-ink bg-coral text-[22px] text-paper shadow-zine-xs">📣</span>
        <h2 className="font-display font-semibold text-[24px] text-ink">Earn 10% for life</h2>
        <p className="max-w-xl font-body font-bold text-[15px] leading-relaxed text-inkSoft">Share any listing, and when someone you referred buys, you earn 10% of every purchase they ever make — paid from the platform's cut, never the creator's.</p>
        <button type="button" disabled={busy || !token} onClick={registerNow} className="rounded-full border-zine border-ink bg-lime px-5 py-2.5 font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-ink shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine disabled:opacity-50">{busy ? 'Setting up…' : 'Become an affiliate'}</button>
      </div>
    );
  }

  const t = me.totals ?? {};
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Lifetime" value={usd(t.lifetime_coins)} tone="bg-lime" />
        <Stat label="This month" value={usd(t.month_coins)} tone="bg-mint" />
        <Stat label="Held" value={usd(t.held_coins)} tone="bg-blue" />
        <Stat label="Referred" value={String(t.referred_users ?? 0)} tone="bg-lilac" />
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-zine border-zine border-ink bg-card p-4 shadow-zine-sm">
        <div>
          <span className="font-mono font-bold uppercase text-[10px] tracking-[0.08em] text-inkSoft">Your code</span>
          <div className="font-display font-semibold text-[22px] text-ink">{me.code ?? '—'}</div>
        </div>
        <a href="/marketplace" className="ml-auto rounded-full border-zine border-ink bg-lime px-4 py-2 font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-ink no-underline shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine">+ Create a link</a>
      </div>

      <div>
        <h2 className="mb-3 font-display font-semibold text-[18px] text-ink">Your links</h2>
        {links.length === 0 ? (
          <div className="rounded-zine border-zine border-ink bg-paper2 p-6 font-body font-bold text-[14px] text-inkSoft shadow-zine-sm">No links yet — open a listing in the marketplace and tap "Share & earn" to create one.</div>
        ) : (
          <div className="overflow-hidden rounded-zine border-zine border-ink bg-card shadow-zine-sm">
            {links.map((l, i) => (
              <div key={l.id} className={`flex flex-wrap items-center gap-3 p-3 ${i ? 'border-t-zine border-ink' : ''}`}>
                <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-blueInk">{l.url ?? l.id}</code>
                <span className="font-mono text-[12px] text-inkSoft">{l.clicks ?? 0} clicks</span>
                <span className="font-mono text-[12px] text-inkSoft">{l.purchases ?? 0} sales</span>
                <span className="font-display font-semibold text-[13px] text-ink">{usd(l.earned_coins)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function AffiliatePanel() { return <ClerkIsland><Inner /></ClerkIsland>; }
export default AffiliatePanel;
