/* Customers — [ADMIN2-PEOPLE 2026-09-26] GET /api/admin/v2/customers?q&cursor.
 * No search: everyone who has booked, most recent booking first. A search looks through
 * every account by name, EXACT email, phone last 4, or a full 10-digit mobile number.
 * Data limit: D1 keeps only a hash of each email (and, for app-only accounts, of the
 * phone), so a partial email cannot match and a hash-only phone needs the full number. */
import { useMemo } from 'react';
import { ChevronRight, Info } from 'lucide-react';
import { istDate, istDateTime } from './adminApi';
import {
  Empty, ErrorBox, ListSkeleton, LoadMore, SearchBox, TD, TH, formatPaise, phoneText, usePaged, useUrlFilters, type Customer,
} from './peopleKit';

interface Row extends Customer { joined_at: number | null; bookings: number; paid_paise: number; last_booked_at: number | null }
const KEYS = ['q'] as const;

export default function Customers() {
  const { f, applied, set, key } = useUrlFilters(KEYS);
  const query = useMemo(() => ({ q: applied.q.trim() || undefined }), [applied]);
  const list = usePaged<Row>('/api/admin/v2/customers', query, key);
  const q = applied.q.trim();
  const partialEmail = q.includes('@') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
        <SearchBox value={f.q} onChange={(v) => set({ q: v })} label="Search customers" placeholder="Name, full email, phone last 4 or full mobile number" />
        <p className="mt-2 flex items-start gap-1.5 text-[12.5px] font-semibold text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Emails are stored only as a secure hash, so type the whole email. Some app accounts keep only a hash of the phone: use the full 10-digit number for those.
        </p>
      </div>

      {partialEmail && (
        <p role="status" className="rounded-lg border border-grand-gold/60 bg-grand-gold/15 px-3 py-2 text-[13px] font-semibold text-foreground">
          Partial emails can't be searched. Type the complete address, like name@gmail.com.
        </p>
      )}

      <p className="text-[13px] font-semibold text-muted-foreground" aria-live="polite">
        {list.phase === 'ready' ? (q ? `${list.items.length}${list.cursor ? '+' : ''} match${list.items.length === 1 ? '' : 'es'}` : 'Customers who have booked, most recent first') : list.phase === 'loading' ? 'Loading…' : ''}
      </p>

      {list.phase === 'loading' ? <ListSkeleton /> : list.phase === 'error' ? <ErrorBox message={list.error ?? 'Could not load customers.'} onRetry={list.reload} /> :
        list.items.length === 0 ? (
          <Empty title={q ? 'No customer matches' : 'No customers yet'} body={q ? 'Check the spelling, or try the full email or full mobile number.' : 'Customers appear here after their first booking.'} />
        ) : (
          <>
            <div className="hidden overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm md:block">
              <table className="w-full border-collapse">
                <thead className="bg-muted/60">
                  <tr><th className={TH}>Customer</th><th className={TH}>Phone</th><th className={`${TH} text-right`}>Bookings</th><th className={`${TH} text-right`}>Paid</th><th className={TH}>Last booking</th><th className={TH}>Joined</th></tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {list.items.map((c) => (
                    <tr key={c.uid} className="cursor-pointer hover:bg-muted/30" onClick={() => { location.href = `/admin/customers/${encodeURIComponent(c.uid)}`; }}>
                      <td className={`${TD} max-w-[280px]`}>
                        <a href={`/admin/customers/${encodeURIComponent(c.uid)}`} onClick={(e) => e.stopPropagation()} className="font-extrabold text-foreground underline-offset-2 hover:text-accent hover:underline">{c.name ?? 'No name'}</a>
                        {c.email && <div className="truncate text-[12.5px] font-semibold text-muted-foreground">{c.email}</div>}
                      </td>
                      <td className={`${TD} text-[13px] tabular-nums ${c.phone_hash_only ? 'italic text-muted-foreground' : ''}`}>{phoneText(c) ?? <span className="text-muted-foreground">—</span>}</td>
                      <td className={`${TD} text-right tabular-nums`}>{c.bookings}</td>
                      <td className={`${TD} text-right font-extrabold tabular-nums`}>{formatPaise(c.paid_paise)}</td>
                      <td className={`${TD} whitespace-nowrap text-[13px] text-muted-foreground`}>{c.last_booked_at ? istDateTime(c.last_booked_at) : '—'}</td>
                      <td className={`${TD} whitespace-nowrap text-[13px] text-muted-foreground`}>{istDate(c.joined_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="space-y-3 md:hidden">
              {list.items.map((c) => (
                <li key={c.uid}>
                  <a href={`/admin/customers/${encodeURIComponent(c.uid)}`} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-4 text-foreground no-underline shadow-sm hover:bg-muted/30">
                    <div className="min-w-0 flex-1">
                      <div className="font-extrabold">{c.name ?? 'No name'}</div>
                      {c.email && <div className="truncate text-[12.5px] font-semibold text-muted-foreground">{c.email}</div>}
                      {phoneText(c) && <div className={`text-[12.5px] font-semibold tabular-nums text-muted-foreground ${c.phone_hash_only ? 'italic' : ''}`}>{phoneText(c)}</div>}
                      <div className="mt-1 text-[12.5px] font-bold text-foreground">{c.bookings} booking{c.bookings === 1 ? '' : 's'} · {formatPaise(c.paid_paise)}</div>
                    </div>
                    <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
                  </a>
                </li>
              ))}
            </ul>
            <LoadMore show={!!list.cursor} busy={list.more} onClick={list.loadMore} shown={list.items.length} />
          </>
        )}
    </div>
  );
}
