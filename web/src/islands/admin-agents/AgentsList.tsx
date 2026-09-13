// [AGENT-LIVE-1] Admin agent list: cards with title, voice, price/min, status,
// seats, KB count, Edit/Publish/Test call. BUILD SPEC §6. 403 from the list
// call renders "Admin only" per D2.
import { useCallback, useEffect, useState } from 'react';
import { adminListAgents, adminPublishAgent, ApiError, type AgentAdminRow } from '../../lib/agentLive';
import { capture, captureException } from '../../lib/analytics';
import { Spinner } from '../../components/Spinner';
import TestCallButton from './TestCallButton';

export default function AgentsList() {
  const [rows, setRows] = useState<AgentAdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adminOnly, setAdminOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAdminOnly(false);
    try {
      const r = await adminListAgents();
      setRows(r);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setAdminOnly(true);
      } else {
        setError(e instanceof ApiError ? e.error : 'Could not load AI voice agents.');
        captureException(e, { where: 'agent_admin_list' });
      }
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function togglePublish(row: AgentAdminRow) {
    setBusy(row.id);
    try {
      const publish = row.status !== 'published';
      const r = await adminPublishAgent(row.id, publish);
      setRows((prev) => prev.map((x) => (x.id === row.id ? { ...x, status: r.status } : x)));
      capture('agent_admin_save', { outcome: publish ? 'published' : 'unpublished' });
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not change publish state.');
      captureException(e, { where: 'agent_admin_publish', agentId: row.id });
    } finally {
      setBusy(null);
    }
  }

  if (adminOnly) {
    return (
      <div className="rounded-zine border-zine border-ink bg-card p-6 shadow-zine-sm">
        <p className="font-body text-[15px] font-bold text-inkSoft">
          Admin only — this area is for the agent administrator.
        </p>
      </div>
    );
  }

  if (loading) {
    return <div className="flex items-center gap-3 p-8"><Spinner size={22} /> <span className="font-body font-bold text-inkSoft">Loading AI voice agents…</span></div>;
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-[24px] font-semibold text-ink">AI voice agents</h2>
        <a
          href="/admin/agents/new"
          className="rounded-full border-zine border-ink bg-lime px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs"
        >
          New agent
        </a>
      </div>

      {error && <div className="rounded-zine border-zine border-ink bg-coral px-4 py-3 font-body text-[14px] font-bold text-paper">{error}</div>}

      {rows.length === 0 ? (
        <div className="rounded-zine border-zine border-ink bg-card p-6 shadow-zine-sm">
          <p className="font-body text-[14px] font-bold text-inkSoft">No AI voice agents yet.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <div key={row.id} className="flex flex-col gap-3 rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
              <div className="flex items-start gap-3">
                {row.coverUrl && <img src={row.coverUrl} alt="" className="h-14 w-14 rounded-zineField border-zine border-ink object-cover" />}
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-display text-[18px] font-semibold text-ink">{row.title}</h3>
                  <span className={`mt-1 inline-block rounded-full px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.06em] ${row.status === 'published' ? 'bg-lime text-ink' : 'bg-paper text-inkSoft'}`}>
                    {row.status}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-body text-[13px] font-bold text-inkSoft">
                <span>Voice</span><span className="text-right text-ink">{row.voice || '—'}</span>
                <span>Price</span><span className="text-right text-ink">₹{row.pricePerMin}/min</span>
                <span>Seats</span><span className="text-right text-ink">{row.maxConcurrent}</span>
                <span>Knowledge</span><span className="text-right text-ink">{row.kbCount} file{row.kbCount === 1 ? '' : 's'}</span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-2">
                <a
                  href={`/admin/agents/${encodeURIComponent(row.id)}`}
                  className="rounded-full border-zine border-ink bg-paper px-3 py-1.5 font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs"
                >
                  Edit
                </a>
                <button
                  type="button"
                  disabled={busy === row.id}
                  onClick={() => void togglePublish(row)}
                  className="rounded-full border-zine border-ink bg-paper px-3 py-1.5 font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50"
                >
                  {busy === row.id ? '…' : row.status === 'published' ? 'Unpublish' : 'Publish'}
                </button>
                <TestCallButton agentId={row.id} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
