/* [HF-HOME-DESI-1] Real creators on the landing page, drawn like the dashboard's My Fraands cards. GET /api/hosts/public (public,
 * no auth) → up to 6, online first, with All / Online tabs. No sample profiles: while nobody is live (or the API is off or
 * unreachable) it shows an honest "first creators are being verified" panel. Read-only. */
import { useEffect, useState } from 'react';
import { API_BASE } from '../../lib/env';
import { capture } from '../../lib/analytics';
import { Avatar, Ic, Lotus, Pill } from '../dashboard-hf/v3/ui';

type Presence = 'online' | 'busy' | 'offline';
interface Host { slug: string; displayName: string; tagline: string | null; avatarUrl: string | null; topics?: string[]; languages?: string[]; pricePerMin?: number; priceLabel?: string; status?: Presence }
const rank = (p?: Presence) => (p === 'online' ? 0 : p === 'busy' ? 1 : 2);
const price = (h: Host) => h.priceLabel || (typeof h.pricePerMin === 'number' && h.pricePerMin > 0 ? `₹${h.pricePerMin}/min` : '');

export default function LiveCreators() {
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [tab, setTab] = useState<'all' | 'online'>('all');
  useEffect(() => {
    let live = true;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    fetch(`${API_BASE}/api/hosts/public?limit=24`, { headers: { accept: 'application/json' }, signal: ctl.signal })
      .then(r => (r.ok ? r.json() : []))
      .then((d: unknown) => { if (live) setHosts(Array.isArray(d) ? (d as Host[]) : []); })
      .catch(() => { if (live) setHosts([]); })
      .finally(() => clearTimeout(t));
    return () => { live = false; ctl.abort(); clearTimeout(t); };
  }, []);

  if (hosts === null) return <div className="h3-grid" aria-busy="true" aria-label="Loading creators">{[0, 1, 2].map(i => <div key={i} className="sk" style={{ height: 170, width: '100%', display: 'block' }} />)}</div>;

  if (hosts.length === 0) return <div className="h3-empty" data-live-creators="empty">
    <Lotus size={84} />
    <p><b style={{ color: 'var(--plum)', fontFamily: 'var(--head)', fontSize: '1.15em' }}>The first creators are getting verified right now.</b><br />Every creator passes Aadhaar and selfie-video checks before going live. Check back soon, or be one of the first.</p>
    <div className="hfl3-acts" style={{ justifyContent: 'center' }}><a className="h3-btn rani" href="/marketplace"><Ic name="search" className="" />Explore creators</a><a className="h3-btn ghost" href="/hosts/join">Become a creator</a></div>
  </div>;

  const sorted = [...hosts].sort((a, b) => rank(a.status) - rank(b.status));
  const online = sorted.filter(h => h.status === 'online').length;
  const list = (tab === 'online' ? sorted.filter(h => h.status === 'online') : sorted).slice(0, 6);
  return <div data-live-creators={list.length}>
    <div className="h3-tabs" role="group" aria-label="Filter">
      <button type="button" className={tab === 'all' ? 'on' : ''} aria-pressed={tab === 'all'} onClick={() => setTab('all')}>All</button>
      <button type="button" className={tab === 'online' ? 'on' : ''} aria-pressed={tab === 'online'} onClick={() => setTab('online')}>Online now · {online}</button>
    </div>
    {list.length === 0 ? <p className="muted">Nobody is online this minute. Try All, or tap Notify me on a profile.</p> :
      <div className="h3-grid">{list.map(h => {
        const presence: Presence = h.status ?? 'offline';
        const chips = [...(h.topics ?? []).slice(0, 2), ...(h.languages ?? []).slice(0, 1)];
        return <a key={h.slug} className="h3-fr" href={`/h/${encodeURIComponent(h.slug)}`} onClick={() => capture('cta_click', { surface: 'home', design_version: 'desi-v1', section: 'creators', action: 'open_creator' })}>
          <span className="h"><Avatar name={h.displayName} seed={h.slug} photo={h.avatarUrl} size="" />
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}><b style={{ fontFamily: 'var(--head)', fontWeight: 900, fontSize: 17 }}>{h.displayName}</b><small className="muted small">@{h.slug}</small></span></span>
          <span><Pill presence={presence} /></span>
          {h.tagline && <span className="topics">{h.tagline}</span>}
          {chips.length > 0 && <span className="meta">{chips.map(c => <span key={c} className="h3-chip dec">{c}</span>)}</span>}
          <span className="foot">{price(h) && <span className="h3-price">{price(h)}</span>}<span className="h3-link">{presence === 'online' ? 'Call now →' : 'View profile →'}</span></span>
        </a>;
      })}</div>}
  </div>;
}
