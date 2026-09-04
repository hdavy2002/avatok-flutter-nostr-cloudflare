// Per-listing moderation history from GET /api/admin/listings/:id
// (`history`), replacing the old /api/admin/audit read that silently
// returned nothing because the endpoint answers `{ entries }`, not `{ items
// }`. `history` is richer anyway — previous/next status, reason, poster
// status — so it renders as a readable timeline instead of a <pre> dump.
import { Badge, fmt } from './adminListingsShared';
import type { HistoryRow } from './adminListingsShared';

export default function AuditTimeline({ history }: { history: HistoryRow[] }) {
  return (
    <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-[18px] font-semibold text-ink">History</h3>
        <span className="font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-inkSoft">this listing's moderation timeline</span>
      </div>
      <div className="mt-4 grid gap-2">
        {history.length === 0 ? (
          <div className="rounded-zineField border-zine border-ink bg-paper2 p-4 font-body text-[14px] font-bold text-inkSoft">No moderation events yet for this listing.</div>
        ) : history.map((row) => (
          <div key={row.id} className="rounded-zineField border-zine border-ink bg-paper2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{row.action}</Badge>
              {row.previous_status || row.next_status ? (
                <span className="font-mono text-[12px] font-bold uppercase tracking-[0.04em] text-inkSoft">
                  {row.previous_status ?? '—'} → {row.next_status ?? '—'}
                </span>
              ) : null}
              {row.poster_status && <Badge tone="bg-lilac text-ink">poster: {row.poster_status}</Badge>}
              <span className="ml-auto font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-inkSoft">{fmt(row.created_at)}</span>
            </div>
            <div className="mt-1 font-mono text-[11px] font-bold uppercase tracking-[0.04em] text-inkMute">by {row.actor_id ?? 'system'}</div>
            {row.reason && <p className="mt-2 font-body text-[13px] font-bold leading-snug text-ink">{row.reason}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
