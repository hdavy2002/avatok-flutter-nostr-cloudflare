import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import { Spinner } from '../../components/Spinner';

type Poster = { status?: string; url?: string; key?: string; generated_at?: number; completed_at?: number; prompt_hash?: string; feedback?: string; error?: string };
type ListingRow = {
  id: string;
  title?: string;
  description?: string;
  kind?: string;
  status?: string;
  price?: number | null;
  cover_media?: Array<{ url?: string }>;
  attrs?: { poster?: Poster } | null;
  created_at?: number;
  updated_at?: number;
  creator_id?: string;
};
type AuditRow = { id: string; admin_id: string; action: string; target: string | null; meta: string | null; created_at: number };

const fmt = (ms?: number) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const money = (n?: number | null) => (typeof n === 'number' ? `₹${n}` : '—');

function Badge({ children, tone = 'bg-paper2 text-inkSoft' }: { children: ReactNode; tone?: string }) {
  return <span className={`inline-flex items-center rounded-full border-zine border-ink px-2 py-0.5 font-mono text-[12px] font-bold uppercase tracking-[0.04em] ${tone}`}>{children}</span>;
}

export default function AdminListings() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ListingRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void (async () => { setToken(await getActiveToken()); setChecked(true); })(); }, []);

  const load = async (t: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await request<{ listings: ListingRow[] }>('/api/admin/listings', { auth: t, query: { status: status === 'all' ? undefined : status } });
      setRows(r.listings ?? []);
      const a = await request<{ items?: AuditRow[] }>('/api/admin/audit', { auth: t, query: { action: 'listing_', limit: 25 } });
      setAudit((a.items ?? []).filter((row) => row.action.startsWith('listing_')));
      setSelected((prev) => prev && (r.listings ?? []).some((row) => row.id === prev) ? prev : (r.listings?.[0]?.id ?? null));
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not load admin listings.');
      setRows([]);
      setAudit([]);
      setSelected(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!checked || !token) { if (checked) setLoading(false); return; }
    void load(token);
  }, [checked, token, status]);

  const current = useMemo(() => rows.find((row) => row.id === selected) ?? null, [rows, selected]);

  async function action(id: string, act: string, payload: Record<string, unknown> = {}) {
    if (!token) return;
    setBusy(`${id}:${act}`);
    setError(null);
    try {
      await request(`/api/admin/listings/${encodeURIComponent(id)}`, { auth: token, method: 'POST', body: { action: act, ...payload } });
      await load(token);
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Action failed.');
    } finally {
      setBusy(null);
    }
  }

  if (!checked || loading) {
    return <div className="flex items-center gap-3 p-8"><Spinner size={22} /> <span className="font-body font-bold text-inkSoft">Loading admin queue…</span></div>;
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
      <aside className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 rounded-zine border-zine border-ink bg-card p-3 shadow-zine-sm">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-full border-zine border-ink bg-paper px-3 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.04em] text-ink outline-none">
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="pending_review">Pending review</option>
            <option value="approved">Approved</option>
            <option value="published">Published</option>
            <option value="rejected">Rejected</option>
          </select>
          <button type="button" onClick={() => token && void load(token)} className="rounded-full border-zine border-ink bg-lime px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs">Refresh</button>
        </div>

        <div className="rounded-zine border-zine border-ink bg-paper2 shadow-zine-sm">
          <div className="border-b-zine border-ink px-4 py-3 font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-inkSoft">Queue</div>
          <div className="max-h-[70vh] overflow-auto">
            {rows.length === 0 ? (
              <div className="p-4 font-body text-[14px] font-bold text-inkSoft">No listings in this queue.</div>
            ) : rows.map((row) => (
              <button key={row.id} type="button" onClick={() => setSelected(row.id)} className={`block w-full border-b-zine border-ink px-4 py-3 text-left last:border-b-0 ${selected === row.id ? 'bg-ink text-paper' : 'bg-transparent hover:bg-paper'}`}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-body text-[14px] font-extrabold">{row.title ?? 'Untitled listing'}</span>
                  <Badge tone={selected === row.id ? 'bg-paper text-ink' : 'bg-paper2 text-inkSoft'}>{row.status ?? 'draft'}</Badge>
                </div>
                <div className={`mt-1 flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.04em] ${selected === row.id ? 'text-paper/80' : 'text-inkSoft'}`}>
                  <span>{row.kind ?? 'listing'}</span>
                  <span>•</span>
                  <span>{money(row.price)}</span>
                  <span>•</span>
                  <span>{fmt(row.updated_at ?? row.created_at)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <section className="flex flex-col gap-5">
        {error && <div className="rounded-zine border-zine border-ink bg-coral px-4 py-3 font-body text-[14px] font-bold text-paper">{error}</div>}
        {current ? (
          <>
            <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate font-display text-[26px] font-semibold text-ink">{current.title ?? 'Untitled listing'}</h2>
                    <Badge>{current.status ?? 'draft'}</Badge>
                    <Badge tone="bg-lime text-ink">{current.kind ?? 'listing'}</Badge>
                  </div>
                  <p className="mt-2 max-w-3xl font-body text-[15px] font-bold leading-relaxed text-inkSoft">{current.description ?? 'No description provided.'}</p>
                </div>
                <div className="flex flex-col items-end gap-2 text-right">
                  <div className="font-display text-[24px] font-semibold text-ink">{money(current.price)}</div>
                  <div className="font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-inkSoft">Listing {current.id}</div>
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded-zine border-zine border-ink bg-paper2 p-5 shadow-zine-sm">
                <h3 className="font-display text-[18px] font-semibold text-ink">Moderation actions</h3>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" disabled={busy !== null} onClick={() => void action(current.id, 'approve_listing')} className="rounded-full border-zine border-ink bg-lime px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50">Approve listing</button>
                  <button type="button" disabled={busy !== null} onClick={() => void action(current.id, 'reject_listing', { reason: 'Needs revision' })} className="rounded-full border-zine border-ink bg-paper px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50">Reject listing</button>
                  <button type="button" disabled={busy !== null} onClick={() => void action(current.id, 'generate_poster')} className="rounded-full border-zine border-ink bg-blue px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-paper shadow-zine-xs disabled:opacity-50">Generate poster</button>
                  <button type="button" disabled={busy !== null} onClick={() => void action(current.id, 'approve_poster')} className="rounded-full border-zine border-ink bg-mint px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50">Approve poster</button>
                  <button type="button" disabled={busy !== null} onClick={() => void action(current.id, 'reject_poster', { feedback: 'Needs crop or copy fixes' })} className="rounded-full border-zine border-ink bg-paper px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50">Reject poster</button>
                  <button type="button" disabled={busy !== null} onClick={() => void action(current.id, 'publish')} className="rounded-full border-zine border-ink bg-ink px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-paper shadow-zine-xs disabled:opacity-50">Publish</button>
                </div>
              </div>

              <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
                <h3 className="font-display text-[18px] font-semibold text-ink">Poster state</h3>
                <div className="mt-3 flex flex-col gap-2 font-body text-[14px] font-bold text-inkSoft">
                  <div>Poster: <span className="text-ink">{current.attrs?.poster?.status ?? 'none'}</span></div>
                  <div>Generated: <span className="text-ink">{fmt(current.attrs?.poster?.generated_at ?? current.attrs?.poster?.completed_at)}</span></div>
                  <div>Asset: <span className="break-all text-ink">{current.attrs?.poster?.url ?? 'not generated yet'}</span></div>
                  {current.attrs?.poster?.error && <div className="text-coral">Error: {current.attrs.poster.error}</div>}
                  {current.attrs?.poster?.feedback && <div>Feedback: <span className="text-ink">{current.attrs.poster.feedback}</span></div>}
                </div>
              </div>
            </div>

            <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-display text-[18px] font-semibold text-ink">Audit trail</h3>
                <span className="font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-inkSoft">latest moderation events</span>
              </div>
              <div className="mt-4 grid gap-2">
                {audit.length === 0 ? (
                  <div className="rounded-zineField border-zine border-ink bg-paper2 p-4 font-body text-[14px] font-bold text-inkSoft">No admin audit entries loaded yet.</div>
                ) : audit.map((row) => (
                  <div key={row.id} className="rounded-zineField border-zine border-ink bg-paper2 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>{row.action}</Badge>
                      <span className="font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-inkSoft">{row.target ?? 'no target'}</span>
                      <span className="ml-auto font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-inkSoft">{fmt(row.created_at)}</span>
                    </div>
                    <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-inkSoft">{row.meta ?? '{}'}</pre>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="rounded-zine border-zine border-ink bg-card p-6 shadow-zine-sm">
            <h2 className="font-display text-[22px] font-semibold text-ink">No listing selected</h2>
            <p className="mt-2 font-body text-[14px] font-bold text-inkSoft">Pick a listing from the queue to inspect the submission, poster state and audit history.</p>
          </div>
        )}
      </section>
    </div>
  );
}
