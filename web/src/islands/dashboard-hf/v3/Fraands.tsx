/* [HF-DASH-V3-1] My Fraands: saved influencers with live presence, filters, sort, a real Call / Notify me / Book button (HostCallActions)
 * and the heart to remove. Worker: GET /api/hf/favourites (now with price block), PUT/DELETE /api/hf/favourites/:slug, notify routes. */
import { useState } from 'react';
import HostCallActions from '../../calls/HostCallActions';
import SaveHostButton from '../../../components/hosts/SaveHostButton';
import SpaceBadges from '../../../components/hosts/SpaceBadges';
import { gateOf, spaceOf } from '../../../lib/hfSpaces';
import { useDash, type Fav } from './data';
import { Avatar, Empty, Failed, Ic, PageHead, Pill, Skel, Sticker } from './ui';

type Tab = 'all' | 'online' | 'busy' | 'offline';
const rank = (p: string) => (p === 'online' ? 0 : p === 'busy' ? 1 : 2);

export default function Fraands() {
  const { favs, reload } = useDash();
  const [tab, setTab] = useState<Tab>('all');
  const [sort, setSort] = useState<'online' | 'recent' | 'name'>('online');
  const [gone, setGone] = useState<Set<string>>(new Set());
  const all = (favs.data ?? []).filter(f => !gone.has(f.slug));
  const list = all.filter(f => tab === 'all' || f.presence === tab).sort(sort === 'name' ? (a, b) => a.displayName.localeCompare(b.displayName) : sort === 'recent' ? (a, b) => b.savedAt - a.savedAt : (a, b) => rank(a.presence) - rank(b.presence));
  const count = (p: Tab) => all.filter(f => f.presence === p).length;
  return <>
    <PageHead eyebrow="My Fraands" title="Teri yaari sabse pyaari" sub="The influencers you hearted. A rose dot means they’re free — tap Call. Busy or offline? Tap Notify me and we’ll WhatsApp you once." art={<Sticker name="yaari" w={120} rot={6} />} />
    <section className="h3-kpis">
      <div className="h3-card h3-kpi"><div className="lbl">Saved</div><div className="big num">{favs.data ? all.length : '—'}</div></div>
      <div className="h3-card h3-kpi"><div className="lbl">Online right now</div><div className="big num" style={{ color: 'var(--rani)' }}>{favs.data ? count('online') : '—'}</div></div>
      <div className="h3-card h3-kpi"><div className="lbl">On a call</div><div className="big num" style={{ color: 'var(--amber)' }}>{favs.data ? count('busy') : '—'}</div></div>
    </section>
    <div className="h3-filters">
      <div className="h3-tabs" role="group" aria-label="Filter">{([['all', 'All'], ['online', 'Online'], ['busy', 'On a call'], ['offline', 'Offline']] as [Tab, string][]).map(([k, l]) =>
        <button key={k} type="button" className={tab === k ? 'on' : ''} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
      <select style={{ marginLeft: 'auto' }} aria-label="Sort" value={sort} onChange={e => setSort(e.target.value as typeof sort)}>
        <option value="online">Online first</option><option value="recent">Recently saved</option><option value="name">Name A–Z</option></select>
    </div>
    {favs.failed ? <Failed onRetry={() => reload('favs')} /> : !favs.data ? <Skel h={260} /> : list.length === 0 ?
      <Empty text={all.length ? 'Koi nahi mila yahan. Try another filter.' : 'No saved influencers yet. Tap the heart on someone you like and they’ll show up here.'}><a className="h3-btn rani" href="/marketplace"><Ic name="search" className="" />Find influencers</a></Empty> :
      <div className="h3-grid">{list.map(f => <FraandCard key={f.slug} f={f} onRemoved={() => { setGone(s => new Set(s).add(f.slug)); }} />)}</div>}
  </>;
}

function FraandCard({ f, onRemoved }: { f: Fav; onRemoved: () => void }) {
  const callHost = { slug: f.slug, displayName: f.displayName, pricePerMin: f.pricePerMin ?? 0, pricePaisePerMin: f.pricePaisePerMin, priceTiers: f.priceTiers, plan: f.plan, status: f.presence, womenOnly: !!f.womenOnly, space: spaceOf(f), callerLevel: f.callerLevel };
  return <div className="h3-fr">
    <div className="h3-fr-heart"><SaveHostButton slug={f.slug} name={f.displayName} surface="dashboard" initialSaved onChange={saved => { if (!saved) onRemoved(); }} /></div>
    <a className="h" href={`/h/${f.slug}`}><Avatar name={f.displayName} seed={f.slug} photo={f.photoUrl} size="" />
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, paddingRight: 40 }}><b style={{ fontFamily: 'var(--head)', fontWeight: 900, fontSize: 17 }}>{f.displayName}</b><small className="muted small">@{f.slug}</small></span></a>
    <div><Pill presence={f.presence} /></div>
    <SpaceBadges videoKyc={f.videoKycVerified} space={spaceOf(f)} surface="favourites" channel={f.channelVerified ? { verified: true, platform: f.channelPlatform, followers: f.followers } : null} callerLevel={gateOf(f) === 'kyc' ? 'video_kyc' : 'everyone'} />
    {f.headline && <div className="topics">{f.headline}</div>}
    {(f.topics?.length || f.languages?.length) ? <div className="meta">{[...(f.topics ?? []).slice(0, 3), ...(f.languages ?? []).slice(0, 2)].map(t => <span key={t} className="h3-chip dec">{t}</span>)}</div> : null}
    <div className="foot">{f.priceLabel && <span className="h3-price">{f.priceLabel}</span>}<a className="h3-link" href={`/h/${f.slug}`}>View profile →</a></div>
    {f.pricePerMin != null && <div className="h3-callwrap"><HostCallActions host={callHost} variant="card" /></div>}
  </div>;
}
