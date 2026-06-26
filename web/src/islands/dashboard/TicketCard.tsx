/* Phase B — TicketCard: one booking row in the dashboard.
 *
 * Maps a /api/booking/list row to the correct viewer deep-link. We render an
 * <a> only — the viewer screens belong to Phases C/D/E.
 */
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';

/** A row from GET /api/booking/list (worker/src/routes/booking.ts listBookings). */
export interface DashboardBooking {
  id: string;
  creator_id?: string;
  buyer_id?: string;
  listing_id?: string;
  kind?: string;
  starts_at?: number;
  ends_at?: number;
  price?: number;
  status?: string;
  title?: string | null;
}

function fmtWhen(ms?: number): string | null {
  if (!ms) return null;
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toUTCString();
  }
}

/** Booking.kind → viewer path. Unknown kinds get no link (display only). */
function viewerFor(b: DashboardBooking): { href: string; label: string } | null {
  const k = (b.kind ?? '').toLowerCase();
  if (k.includes('consult')) return { href: `/consult/${encodeURIComponent(b.id)}`, label: 'Join consult' };
  if (k.includes('live') && b.listing_id) return { href: `/watch/${encodeURIComponent(b.listing_id)}`, label: 'Watch' };
  if (k.includes('agent') && b.listing_id) return { href: `/agent/${encodeURIComponent(b.listing_id)}`, label: 'Talk' };
  return null;
}

export interface TicketCardProps {
  booking: DashboardBooking;
  /** Past bookings are rendered muted with no join CTA. */
  past?: boolean;
}

export function TicketCard({ booking, past }: TicketCardProps) {
  const when = fmtWhen(booking.starts_at);
  const viewer = past ? null : viewerFor(booking);
  const status = (booking.status ?? '').toLowerCase();
  const statusKind = status === 'confirmed' ? 'ok' : status === 'cancelled' ? 'no' : 'hint';

  return (
    <Card shadow="sm" fillClassName={past ? 'bg-paper2' : 'bg-card'}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-display font-semibold text-[17px] text-ink">
            {booking.title ?? 'AvaTOK session'}
          </span>
          {when && (
            <span className="font-mono text-[12px] uppercase tracking-[0.06em] text-inkSoft">{when}</span>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {booking.status && <Pill kind={statusKind}>{booking.status}</Pill>}
            {booking.price ? <Pill kind="plain">{booking.price.toLocaleString()} Tokens</Pill> : null}
          </div>
        </div>
        {viewer && (
          <a
            href={viewer.href}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-full border-zine border-ink bg-lime px-4 py-2.5 font-display font-semibold text-[15px] text-ink no-underline shadow-zine-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed transition-transform duration-zine"
          >
            {viewer.label} →
          </a>
        )}
      </div>
    </Card>
  );
}

export default TicketCard;
