// Per-listing moderation history from GET /api/admin/listings/:id
// (`history`), replacing the old /api/admin/audit read that silently
// returned nothing because the endpoint answers `{ entries }`, not `{ items
// }`. `history` is richer anyway — previous/next status, reason, poster
// status — so it renders as a readable timeline instead of a <pre> dump.
//
// [ADMIN-PLAIN-1 2026-09-05] Rewritten for a NON-TECHNICAL reader. It used to
// print `regenerate_poster`, `pending_review → approved`, a 40-character clerk
// uid, and — for an admin edit — the raw JSON diff as a paragraph:
//   {"starts_at":{"from":null,"to":1788815520000},"duration_min":{"from":null,"to":60}}
// The owner: "I see lots of code, as a non tech admin, its confusing to me."
// Every one of those is now a sentence, a name, or a formatted value.
import { Badge, fmt } from './adminListingsShared';
import type { HistoryRow } from './adminListingsShared';
import { actionLabel, statusLabel, posterStatusLabel, personLabel, fieldLabel, fieldValueLabel } from './labels';

/** The `reason` column carries a JSON diff for `admin_edit` and free text for
 *  everything else. Parse only when it is genuinely our diff shape; anything
 *  else is a human's rejection reason and must be shown exactly as written. */
type Diff = Record<string, { from: unknown; to: unknown }>;
function parseDiff(action: string, reason: string | null | undefined): Diff | null {
  if (action !== 'admin_edit' || !reason) return null;
  try {
    const v = JSON.parse(reason);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    for (const k of Object.keys(v)) {
      if (!v[k] || typeof v[k] !== 'object' || !('from' in v[k]) || !('to' in v[k])) return null;
    }
    return v as Diff;
  } catch { return null; }
}

export default function AuditTimeline({ history, actorNames }: {
  history: HistoryRow[];
  actorNames?: Record<string, string> | null;
}) {
  return (
    <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-[18px] font-semibold text-ink">History</h3>
        <span className="font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-inkSoft">what happened to this listing</span>
      </div>
      <div className="mt-4 grid gap-2">
        {history.length === 0 ? (
          <div className="rounded-zineField border-zine border-ink bg-paper2 p-4 font-body text-[14px] font-bold text-inkSoft">Nothing has happened to this listing yet.</div>
        ) : history.map((row) => {
          const diff = parseDiff(row.action, row.reason);
          // A status that did not change is noise on a timeline — an admin edit
          // and a poster action both read "approved → approved", which says
          // nothing and crowds out what actually happened.
          const moved = row.previous_status && row.next_status && row.previous_status !== row.next_status;
          return (
            <div key={row.id} className="rounded-zineField border-zine border-ink bg-paper2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{actionLabel(row.action)}</Badge>
                {moved && (
                  <span className="font-body text-[13px] font-bold text-inkSoft">
                    {statusLabel(row.previous_status)} → {statusLabel(row.next_status)}
                  </span>
                )}
                {row.poster_status && (
                  <Badge tone="bg-lilac text-ink">Poster: {posterStatusLabel(row.poster_status)}</Badge>
                )}
                <span className="ml-auto font-body text-[13px] font-bold text-inkSoft">{fmt(row.created_at)}</span>
              </div>
              <div className="mt-1 font-body text-[13px] font-bold text-inkMute">
                by {personLabel(row.actor_id, actorNames)}
              </div>

              {diff ? (
                <ul className="mt-2 flex flex-col gap-1">
                  {Object.entries(diff).map(([field, ch]) => (
                    <li key={field} className="font-body text-[13px] font-bold text-ink">
                      <span className="text-inkSoft">{fieldLabel(field)}:</span>{' '}
                      {fieldValueLabel(field, ch.from)} → {fieldValueLabel(field, ch.to)}
                    </li>
                  ))}
                </ul>
              ) : row.reason ? (
                <p className="mt-2 font-body text-[13px] font-bold leading-snug text-ink">{row.reason}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
