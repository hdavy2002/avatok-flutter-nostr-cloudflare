import { useEffect, useState } from 'react';
import { AdminGate } from './AdminGate';
import { getAdminListings, adminListingAction } from './adminApi';

function Inner() {
  const [rows, setRows] = useState<any[]>([]); const [status, setStatus] = useState('all'); const [busy, setBusy] = useState('');
  const load = async () => { const r = await getAdminListings(status); setRows(r.listings || []); };
  useEffect(() => { void load(); }, [status]);
  const act = async (id: string, action: string) => { setBusy(id + action); try { await adminListingAction(id, action); await load(); } finally { setBusy(''); } };
  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap gap-2">{['all','draft','pending_review','approved','rejected','published'].map(s => <button key={s} onClick={() => setStatus(s)} className={`rounded-full border-zine border-ink px-3 py-1 font-mono text-xs font-bold uppercase ${status===s?'bg-lime':'bg-card'}`}>{s.replace('_',' ')}</button>)}</div>
    {!rows.length && <p className="font-mono text-sm text-inkMute">No listings in this queue.</p>}
    {rows.map(l => { let a:any={}; try { a=JSON.parse(l.attrs||'{}'); } catch {} const poster=a.poster; return <article key={l.id} className="rounded-xl border-zine border-ink bg-card p-4 shadow-zine-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-display text-xl font-semibold">{l.title || 'Untitled listing'}</h3><p className="font-mono text-xs uppercase text-inkMute">{l.kind} · {l.creator_name || l.creator_id} · {l.status}</p><p className="mt-2 max-w-2xl text-sm text-inkSoft">{l.description || 'No description'}</p>{poster?.url && <img src={poster.url} alt="Generated poster preview" className="mt-3 max-h-64 rounded-lg border border-ink object-contain" />}</div><span className="rounded-full border border-ink px-2 py-1 font-mono text-xs font-bold">poster: {poster?.status || 'none'}</span></div><div className="mt-4 flex flex-wrap gap-2">{l.status==='draft' && <button disabled={!!busy} onClick={()=>void act(l.id,'approve_listing')} className="rounded-full bg-lime px-3 py-2 font-mono text-xs font-bold">Approve listing</button>}{(!poster || poster.status==='failed' || poster.status==='rejected') && <button disabled={!!busy} onClick={()=>void act(l.id,'generate_poster')} className="rounded-full bg-blueInk px-3 py-2 font-mono text-xs font-bold text-white">{poster ? 'Regenerate poster' : 'Generate poster draft'}</button>}{poster?.status==='draft' && <button disabled={!!busy} onClick={()=>void act(l.id,'approve_poster')} className="rounded-full bg-lime px-3 py-2 font-mono text-xs font-bold">Approve poster</button>}{poster?.status==='approved' && l.status!=='published' && <button disabled={!!busy} onClick={()=>void act(l.id,'publish')} className="rounded-full bg-coral px-3 py-2 font-mono text-xs font-bold text-white">Publish</button>}<a href={`/l/${l.id}`} target="_blank" rel="noreferrer" className="rounded-full border border-ink px-3 py-2 font-mono text-xs font-bold">Preview details</a></div></article>; })}
  </div>;
}
export default function ListingsPanel() {
  return <AdminGate><Inner /></AdminGate>;
}
