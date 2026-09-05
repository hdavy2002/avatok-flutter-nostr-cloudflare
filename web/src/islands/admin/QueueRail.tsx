// The 360px queue rail: status filter, refresh, and the list of listings
// awaiting review. Extracted from AdminListings.tsx unchanged in behaviour.
import { Badge, fmt, money, type ListingRow } from './adminListingsShared';
import { statusLabel, kindLabel } from './labels';

export default function QueueRail({
  rows,
  selected,
  status,
  onStatusChange,
  onSelect,
  onRefresh,
}: {
  rows: ListingRow[];
  selected: string | null;
  status: string;
  onStatusChange: (s: string) => void;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <aside className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 rounded-zine border-zine border-ink bg-card p-3 shadow-zine-sm">
        <select
          value={status}
          onChange={(e) => onStatusChange(e.target.value)}
          className="rounded-full border-zine border-ink bg-paper px-3 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.04em] text-ink outline-none"
        >
          <option value="all">All statuses</option>
          <option value="draft">Draft</option>
          <option value="pending_review">Pending review</option>
          <option value="approved">Approved</option>
          <option value="published">Published</option>
          <option value="rejected">Rejected</option>
        </select>
        <button type="button" onClick={onRefresh} className="rounded-full border-zine border-ink bg-lime px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs">Refresh</button>
      </div>

      <div className="rounded-zine border-zine border-ink bg-paper2 shadow-zine-sm">
        <div className="border-b-zine border-ink px-4 py-3 font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-inkSoft">Queue</div>
        <div className="max-h-[70vh] overflow-auto">
          {rows.length === 0 ? (
            <div className="p-4 font-body text-[14px] font-bold text-inkSoft">No listings in this queue.</div>
          ) : rows.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => onSelect(row.id)}
              className={`block w-full border-b-zine border-ink px-4 py-3 text-left last:border-b-0 ${selected === row.id ? 'bg-ink text-paper' : 'bg-transparent hover:bg-paper'}`}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-body text-[14px] font-extrabold">{row.title ?? 'Untitled listing'}</span>
                <Badge tone={selected === row.id ? 'bg-paper text-ink' : 'bg-paper2 text-inkSoft'}>{statusLabel(row.status ?? 'draft')}</Badge>
              </div>
              <div className={`mt-1 flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.04em] ${selected === row.id ? 'text-paper/80' : 'text-inkSoft'}`}>
                <span>{kindLabel(row.kind ?? 'listing')}</span>
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
  );
}
