/* Overview — the /dashboard home, a web take on the app's AvaVerse dashboard.
 * Shows the wallet balance, quick links into the manage surfaces, and a compact
 * "Upcoming" list. Read-only; everything links deeper. Requires a session (the
 * shell already guards, but we read the token to fetch per-user data).
 */
import { useEffect, useState } from 'react';
import { ClerkIsland, getActiveToken } from '../../lib/clerk';
import { request } from '../../lib/apiClient';
import { Card } from '../../components/Card';
import { Spinner } from '../../components/Spinner';
import { TicketCard } from './TicketCard';
import type { DashboardBooking } from './TicketCard';
import type { WalletBalance } from '../checkout/types';

const QUICK: { href: string; label: string; sub: string; tone: string; chip: string }[] = [
  { href: '/dashboard/listings/new', label: 'New listing', sub: 'Live, 1:1, class or agent', tone: 'bg-lime', chip: '＋' },
  { href: '/dashboard/listings', label: 'My listings', sub: 'Drafts & published', tone: 'bg-card', chip: '≡' },
  { href: '/dashboard/bookings', label: 'Bookings', sub: 'Upcoming & past', tone: 'bg-card', chip: '◷' },
  { href: '/dashboard/wallet', label: 'Wallet', sub: 'Balance & ledger', tone: 'bg-card', chip: '⛁' },
];

function Inner() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [upcoming, setUpcoming] = useState<DashboardBooking[] | null>(null);

  useEffect(() => {
    void (async () => {
      const t = await getActiveToken();
      setToken(t);
      setChecked(true);
    })();
  }, []);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const r = await request<WalletBalance>('/api/wallet/balance', { auth: token });
        setBalance(Math.trunc(Number(r.balance ?? 0)));
      } catch {
        setBalance(null);
      }
    })();
    void (async () => {
      try {
        const r = await request<{ bookings: DashboardBooking[] }>('/api/booking/list', {
          auth: token,
          query: { role: 'buyer', when: 'upcoming' },
        });
        setUpcoming(r.bookings ?? []);
      } catch {
        setUpcoming([]);
      }
    })();
  }, [token]);

  if (!checked) {
    return (
      <div className="flex items-center gap-3 p-6">
        <Spinner size={22} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <span className="font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">Your dashboard</span>
        <h1 className="mt-2 font-display font-semibold text-[30px] leading-tight text-ink">Overview</h1>
      </header>

      {/* Wallet strip */}
      <Card fillClassName="bg-mint" shadow="sm">
        <div className="flex items-center justify-between">
          <span className="font-mono font-bold uppercase text-[12px] tracking-[0.08em] text-ink">Wallet balance</span>
          <a href="/dashboard/wallet" className="font-mono font-bold text-[18px] text-ink no-underline">
            {balance != null ? `${balance.toLocaleString()} AvaCoins` : '—'}
          </a>
        </div>
      </Card>

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {QUICK.map((q) => (
          <a
            key={q.href}
            href={q.href}
            className="flex flex-col gap-2 rounded-zine border-zine border-ink bg-card p-4 no-underline shadow-zine-sm transition-transform duration-zine hover:-translate-y-[1px] active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed"
          >
            <span className={`flex h-9 w-9 items-center justify-center rounded-zineBadge border-zine border-ink ${q.tone} text-[16px] shadow-zine-xs`}>{q.chip}</span>
            <span className="font-display font-semibold text-[16px] text-ink">{q.label}</span>
            <span className="font-body font-bold text-[12px] text-inkSoft">{q.sub}</span>
          </a>
        ))}
      </div>

      {/* Upcoming */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display font-semibold text-[20px] text-ink">Upcoming</h2>
          <a href="/dashboard/bookings" className="font-mono font-bold uppercase text-[11px] tracking-[0.06em] text-blueInk no-underline">View all →</a>
        </div>
        {!upcoming ? (
          <div className="flex items-center gap-3 p-4"><Spinner size={20} /></div>
        ) : upcoming.length ? (
          <div className="flex flex-col gap-3">
            {upcoming.slice(0, 3).map((b) => (
              <TicketCard key={b.id} booking={b} />
            ))}
          </div>
        ) : (
          <Card fillClassName="bg-paper2">
            <p className="font-body font-bold text-[15px] text-inkSoft">
              Nothing booked yet.{' '}
              <a href="/marketplace" className="text-blueInk underline decoration-blue decoration-2 underline-offset-2">Explore the marketplace</a>.
            </p>
          </Card>
        )}
      </section>
    </div>
  );
}

export function Overview() {
  return (
    <ClerkIsland>
      <Inner />
    </ClerkIsland>
  );
}

export default Overview;
