/* CreatorAgents — manage your AI agents (AvaVision / AvaVoice) from the web.
 *
 * Cards for the creator's own agents with a filter bar (search + status) and
 * Edit / Publish-Unpublish (archive) / Delete actions, wired to the real APIs:
 *   vision: GET /api/avavision/agents/mine, publish, unpublish, DELETE
 *   voice:  GET /api/avavoice/agents/mine,  publish, unpublish, DELETE
 * The live coaching/voice SESSION (camera + mic) stays in the phone app — here
 * we only create and manage the agent listing.
 */
import { useEffect, useMemo, useState } from 'react';
import { ClerkIsland, getActiveToken } from '../../lib/clerk';
import { cfImage } from '../../lib/config';
import { Spinner } from '../../components/Spinner';
import * as visionApi from '../vision/avavisionApi';
import * as voiceApi from '../agent/api';

type Agent = { id: string; name: string; role: string; status: string; ratePerHourCoins: number; images: string[]; avatarUrl?: string | null; callsTotal: number; ratingAvg?: number | null };

function adapter(service: 'vision' | 'voice') {
  if (service === 'vision') {
    return {
      getMine: visionApi.getMine as (a: string) => Promise<Agent[]>,
      publish: visionApi.publishAgent, unpublish: visionApi.unpublishAgent, remove: visionApi.deleteAgent,
      editHref: (id: string) => `/vision/studio?id=${encodeURIComponent(id)}`,
      createHref: '/vision/studio',
    };
  }
  return {
    getMine: voiceApi.getMine as (a: string) => Promise<Agent[]>,
    publish: voiceApi.publishAgent, unpublish: voiceApi.unpublishAgent, remove: voiceApi.deleteAgent,
    editHref: (_id: string) => '', // no web voice studio yet
    createHref: '', // create voice agents in the app for now
  };
}

function coins(n?: number | null) {
  if (!n) return 'Free';
  return `$${(n / 100).toFixed(0)}/hr`;
}

function Inner({ service }: { service: 'vision' | 'voice' }) {
  const api = useMemo(() => adapter(service), [service]);
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [rows, setRows] = useState<Agent[] | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { void (async () => { setToken(await getActiveToken()); setChecked(true); })(); }, []);
  useEffect(() => {
    if (!checked) return;
    if (!token) { setRows([]); return; }
    void (async () => { try { setRows(await api.getMine(token)); } catch { setRows([]); } })();
  }, [token, checked]);

  const filtered = useMemo(() => {
    let list = rows ?? [];
    if (status !== 'all') list = list.filter((a) => (a.status || 'draft') === status);
    const n = q.trim().toLowerCase();
    if (n) list = list.filter((a) => (a.name || '').toLowerCase().includes(n) || (a.role || '').toLowerCase().includes(n));
    return list;
  }, [rows, q, status]);

  async function toggle(a: Agent) {
    if (!token) return; setBusy(a.id);
    try {
      if ((a.status || 'draft') === 'published') { await api.unpublish(a.id, token); setRows((p) => (p ?? []).map((x) => x.id === a.id ? { ...x, status: 'draft' } : x)); }
      else { await api.publish(a.id, token); setRows((p) => (p ?? []).map((x) => x.id === a.id ? { ...x, status: 'published' } : x)); }
    } catch { alert('Could not update — check the agent is complete, then try again.'); }
    setBusy(null);
  }
  async function del(a: Agent) {
    if (!token || !confirm(`Delete "${a.name}"? This cannot be undone.`)) return; setBusy(a.id);
    try { await api.remove(a.id, token); setRows((p) => (p ?? []).filter((x) => x.id !== a.id)); }
    catch { alert('Could not delete — try again.'); }
    setBusy(null);
  }

  if (!checked || rows === null) return <div className="flex items-center gap-3 p-8"><Spinner size={22} /> <span className="font-body font-bold text-inkSoft">Loading your agents…</span></div>;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2.5 rounded-zine border-zine border-ink bg-card p-2.5 shadow-zine-sm">
        <div className="flex min-w-[200px] flex-1 items-center gap-2 rounded-full border-zine border-ink bg-paper px-3 py-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="text-inkMute"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your agents…" className="min-w-0 flex-1 bg-transparent font-body font-bold text-[14px] text-ink outline-none placeholder:text-placeholder" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-full border-zine border-ink bg-paper px-3 py-2 font-mono font-bold text-[12px] uppercase tracking-[0.04em] text-ink outline-none">
          <option value="all">All</option><option value="draft">Draft</option><option value="published">Published</option>
        </select>
        {api.createHref
          ? <a href={api.createHref} className="rounded-full border-zine border-ink bg-lime px-4 py-2 font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-ink no-underline shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine">+ Create</a>
          : <span className="rounded-full border-zine border-ink bg-paper2 px-4 py-2 font-mono font-bold uppercase text-[11px] tracking-[0.04em] text-inkMute">Create in the app</span>}
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-zine border-zine border-ink bg-paper2 p-8 shadow-zine-sm">
          <h2 className="font-display font-semibold text-[20px] text-ink">{rows.length === 0 ? 'No agents yet' : 'Nothing matches that filter'}</h2>
          <p className="max-w-md font-body font-bold text-[15px] text-inkSoft">
            {service === 'vision'
              ? 'Create an AI vision coach — pick a template, set the prompt and rate, then publish. Sessions run in the app.'
              : 'Create AI voice agents in the AvaTOK app, then manage and publish them here.'}
          </p>
          {rows.length === 0 && api.createHref && <a href={api.createHref} className="rounded-full border-zine border-ink bg-lime px-5 py-2.5 font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-ink no-underline shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine">Create your first one</a>}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((a) => {
            const published = (a.status || 'draft') === 'published';
            const img = a.images?.[0] || a.avatarUrl;
            return (
              <div key={a.id} className="flex flex-col overflow-hidden rounded-zine border-zine border-ink bg-card shadow-zine-sm transition-transform duration-zine hover:-translate-y-[2px]">
                <div className="relative aspect-[16/10] w-full border-b-zine border-ink bg-paper2">
                  {img ? <img src={cfImage(img, { width: 480 })} alt="" className="h-full w-full object-cover" loading="lazy" /> : <div className="flex h-full w-full items-center justify-center font-mono text-[12px] text-inkMute">No image</div>}
                  <span className={`absolute left-2 top-2 rounded-full border-zine border-ink px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.04em] shadow-zine-xs ${published ? 'bg-mint text-ink' : 'bg-paper2 text-inkSoft'}`}>{published ? 'published' : 'draft'}</span>
                </div>
                <div className="flex flex-1 flex-col gap-1 p-3">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-display font-semibold text-[16px] text-ink">{a.name || 'Untitled agent'}</span>
                    <span className="ml-auto whitespace-nowrap font-display font-semibold text-[13px] text-blueInk">{coins(a.ratePerHourCoins)}</span>
                  </div>
                  {a.role && <p className="line-clamp-1 font-body font-bold text-[13px] text-inkSoft">{a.role}</p>}
                  <div className="mt-auto flex items-center gap-1.5 pt-2">
                    {api.editHref(a.id)
                      ? <a href={api.editHref(a.id)} className="flex-1 rounded-zineField border-zine border-ink bg-paper px-2 py-1.5 text-center font-mono font-bold uppercase text-[11px] tracking-[0.04em] text-ink no-underline shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine">Edit</a>
                      : <span className="flex-1 rounded-zineField border-zine border-ink bg-paper2 px-2 py-1.5 text-center font-mono font-bold uppercase text-[11px] tracking-[0.04em] text-inkMute">App</span>}
                    <button type="button" disabled={busy === a.id} onClick={() => toggle(a)} className="flex-1 rounded-zineField border-zine border-ink bg-paper2 px-2 py-1.5 font-mono font-bold uppercase text-[11px] tracking-[0.04em] text-inkSoft shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine disabled:opacity-50">{published ? 'Unpublish' : 'Publish'}</button>
                    <button type="button" disabled={busy === a.id} onClick={() => del(a)} className="rounded-zineField border-zine border-ink bg-paper px-2.5 py-1.5 font-mono font-bold uppercase text-[11px] tracking-[0.04em] text-coral shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine disabled:opacity-50" aria-label="Delete">✕</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CreatorAgents({ service }: { service: 'vision' | 'voice' }) {
  return <ClerkIsland><Inner service={service} /></ClerkIsland>;
}
export default CreatorAgents;
