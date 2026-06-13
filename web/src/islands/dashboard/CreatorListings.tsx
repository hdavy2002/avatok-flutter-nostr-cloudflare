/* CreatorListings — the creator's listing pipeline for the web dashboard.
 *
 * One reusable surface for "My listings", AvaConsult and AvaLive: a filter bar
 * (search + status, and kind when not pinned) over the creator's own listings,
 * rendered as cards with Edit / Archive / Delete actions. Wired to the real API:
 *   GET    /api/listings/mine            → { listings: Card[] }
 *   DELETE /api/listings/:id             → remove
 *   POST   /api/listings/:id/status      → { status:'cancelled' } (archive)
 * Create is the existing flow at /dashboard/listings/new.
 *
 * Anything that uses camera/mic/speaker (going live, the consult video room) is
 * the phone app's job — here we only manage the listings themselves.
 */
import { useEffect, useMemo, useState } from 'react';
import { ClerkIsland, getActiveToken } from '../../lib/clerk';
import { request } from '../../lib/apiClient';
import { cfImage } from '../../lib/config';
import { Spinner } from '../../components/Spinner';
import type { Card as ListingCard } from '../../lib/types';

type Row = ListingCard & { status?: string; joined_count?: number };

const KIND_LABEL: Record<string, string> = {
  live_event: 'Live event',
  live: 'Live event',
  consult: '1:1 consult',
  agent: 'AI agent',
  event: 'Event',
  content: 'Content',
};

const STATUS_TONE: Record<string, string> = {
  draft: 'bg-paper2 text-inkSoft',
  published: 'bg-mint text-ink',
  live: 'bg-coral text-paper',
  completed: 'bg-blue text-ink',
  cancelled: 'bg-paper2 text-inkMute line-through',
};

function coins(n?: number | null) {
  if (n == null) return 'Free';
  if (n === 0) return 'Free';
  return `${n.toLocaleString()} coins`;
}

function Inner({ kind, createHref, emptyTitle, emptyBody }: {
  kind?: string; createHref: string; emptyTitle: string; emptyBody: string;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { void (async () => { setToken(await getActiveToken()); setChecked(true); })(); }, []);

  useEffect(() => {
    if (!checked) return;
    if (!token) { setRows([]); return; }
    void (async () => {
      try {
        const r = await request<{ listings: Row[] }>('/api/listings/mine', { auth: token });
        setRows(r.listings ?? []);
      } catch { setRows([]); }
    })();
  }, [token, checked]);

  const filtered = useMemo(() => {
    let list = rows ?? [];
    if (kind) list = list.filter((l) => (l.kind === kind) || (kind === 'live_event' && l.kind === 'live'));
    if (status !== 'all') list = list.filter((l) => (l.status ?? 'draft') === status);
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((l) => (l.title ?? '').toLowerCase().includes(needle));
    return list;
  }, [rows, kind, status, q]);

  async function archive(id: string) {
    if (!token || !confirm('Archive this listing? It will be removed from the marketplace.')) return;
    setBusy(id);
    try {
      await request(`/api/listings/${id}/status`, { method: 'POST', auth: token, body: { status: 'cancelled' } });
      setRows((prev) => (prev ?? []).map((l) => (l.id === id ? { ...l, status: 'cancelled' } : l)));
    } catch { alert('Could not archive — try again.'); }
    setBusy(null);
  }
  async function remove(id: string) {
    if (!token || !confirm('Delete this listing permanently? This cannot be undone.')) return;
    setBusy(id);
    try {
      await request(`/api/listings/${id}`, { method: 'DELETE', auth: token });
      setRows((prev) => (prev ?? []).filter((l) => l.id !== id));
    } catch { alert('Could not delete — try again.'); }
    setBusy(null);
  }

  if (!checked || rows === null) {
    return <div className="flex items-center gap-3 p-8"><Spinner size={22} /> <span className="font-body font-bold text-inkSoft">Loading your listings…</span></div>;
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2.5 rounded-zine border-zine border-ink bg-card p-2.5 shadow-zine-sm">
        <div className="flex min-w-[200px] flex-1 items-center gap-2 rounded-full border-zine border-ink bg-paper px-3 py-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="text-inkMute"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your listings…" className="min-w-0 flex-1 bg-transparent font-body font-bold text-[14px] text-ink outline-none placeholder:text-placeholder" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-full border-zine border-ink bg-paper px-3 py-2 font-mono font-bold text-[12px] uppercase tracking-[0.04em] text-ink outline-none">
          <option value="all">All statuses</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="live">Live</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Archived</option>
        </select>
        <a href={createHref} className="rounded-full border-zine border-ink bg-lime px-4 py-2 font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-ink no-underline shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine">+ Create</a>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-zine border-zine border-ink bg-paper2 p-8 shadow-zine-sm">
          <h2 className="font-display font-semibold text-[20px] text-ink">{rows.length === 0 ? emptyTitle : 'Nothing matches that filter'}</h2>
          <p className="max-w-md font-body font-bold text-[15px] text-inkSoft">{rows.length === 0 ? emptyBody : 'Try a different search or status.'}</p>
          {rows.length === 0 && (
            <a href={createHref} className="rounded-full border-zine border-ink bg-lime px-5 py-2.5 font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-ink no-underline shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine">Create your first one</a>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((l) => {
            const st = (l.status ?? 'draft') as string;
            return (
              <div key={l.id} className="flex flex-col overflow-hidden rounded-zine border-zine border-ink bg-card shadow-zine-sm transition-transform duration-zine hover:-translate-y-[2px]">
                <div className="relative aspect-[16/10] w-full border-b-zine border-ink bg-paper2">
                  {l.poster ? (
                    <img src={cfImage(l.poster, { width: 480 })} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center font-mono text-[12px] text-inkMute">No cover photo</div>
                  )}
                  <span className={`absolute left-2 top-2 rounded-full border-zine border-ink px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.04em] shadow-zine-xs ${STATUS_TONE[st] ?? 'bg-paper2 text-inkSoft'}`}>{st}</span>
                </div>
                <div className="flex flex-1 flex-col gap-1 p-3">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full border-zine border-ink bg-paper px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-inkSoft">{KIND_LABEL[l.kind ?? ''] ?? l.kind ?? 'Listing'}</span>
                    <span className="ml-auto font-display font-semibold text-[14px] text-blueInk">{coins(l.price)}</span>
                  </div>
                  <h3 className="line-clamp-2 font-display font-semibold text-[16px] leading-tight text-ink">{l.title}</h3>
                  <div className="mt-auto flex items-center gap-1.5 pt-2">
                    <a href={`/dashboard/listings/new?id=${encodeURIComponent(l.id)}`} className="flex-1 rounded-zineField border-zine border-ink bg-paper px-2 py-1.5 text-center font-mono font-bold uppercase text-[11px] tracking-[0.04em] text-ink no-underline shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine">Edit</a>
                    {st !== 'cancelled' && (
                      <button type="button" disabled={busy === l.id} onClick={() => archive(l.id)} className="flex-1 rounded-zineField border-zine border-ink bg-paper2 px-2 py-1.5 font-mono font-bold uppercase text-[11px] tracking-[0.04em] text-inkSoft shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine disabled:opacity-50">Archive</button>
                    )}
                    <button type="button" disabled={busy === l.id} onClick={() => remove(l.id)} className="rounded-zineField border-zine border-ink bg-paper px-2.5 py-1.5 font-mono font-bold uppercase text-[11px] tracking-[0.04em] text-coral shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine disabled:opacity-50" aria-label="Delete">✕</button>
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

export function CreatorListings(props: { kind?: string; createHref?: string; emptyTitle?: string; emptyBody?: string }) {
  return (
    <ClerkIsland>
      <Inner
        kind={props.kind}
        createHref={props.createHref ?? '/dashboard/listings/new'}
        emptyTitle={props.emptyTitle ?? 'No listings yet'}
        emptyBody={props.emptyBody ?? 'Publish a live event, a 1:1 consult or a class — fans book and pay right from the web.'}
      />
    </ClerkIsland>
  );
}

export default CreatorListings;
