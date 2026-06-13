/* Phase B — MyBookings: the signed-in consumer dashboard island.
 *
 *   • bookings → GET /api/booking/list?role=buyer&when=upcoming|past  → { bookings }
 *   • wallet   → GET /api/wallet/balance                              → { balance }
 *
 * Requires a session (guest or full). If the viewer is anonymous we show a
 * quiet sign-in/return-home prompt rather than opening the gate on load — the
 * dashboard is a destination, not a gated action.
 */
import { useCallback, useEffect, useState } from 'react';
import { ClerkIsland, getActiveToken, SignInButton } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Spinner } from '../../components/Spinner';
import { TicketCard } from './TicketCard';
import type { DashboardBooking } from './TicketCard';
import type { WalletBalance } from '../checkout/types';

type Tab = 'upcoming' | 'past';

function DashboardInner() {
  const [token, setToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [tab, setTab] = useState<Tab>('upcoming');
  const [bookings, setBookings] = useState<DashboardBooking[] | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setToken(await getActiveToken());
      setAuthChecked(true);
    })();
  }, []);

  const loadBookings = useCallback(
    async (jwt: string, which: Tab) => {
      setLoading(true);
      setError(null);
      try {
        const r = await request<{ bookings: DashboardBooking[] }>('/api/booking/list', {
          auth: jwt,
          query: { role: 'buyer', when: which },
        });
        setBookings(r.bookings ?? []);
      } catch (e) {
        setError(e instanceof ApiError ? e.error : 'Could not load your bookings.');
        setBookings([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Load bookings + balance once we have a token / when the tab changes.
  useEffect(() => {
    if (!token) return;
    void loadBookings(token, tab);
  }, [token, tab, loadBookings]);

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
  }, [token]);

  if (!authChecked) {
    return (
      <div className="flex items-center gap-3 p-6">
        <Spinner size={22} />
      </div>
    );
  }

  if (!token) {
    return (
      <Card shadow="lg">
        <div className="flex flex-col gap-3">
          <h2 className="font-display font-semibold text-[22px] text-ink">Sign in to see your bookings</h2>
          <p className="font-body font-bold text-[15px] text-inkSoft">
            Your bookings, tickets and wallet live here once you’ve booked something.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <SignInButton mode="modal">
              <Button variant="lime" label="Sign in" />
            </SignInButton>
            <a
              href="/explore"
              className="font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-blueInk underline decoration-blue decoration-2 underline-offset-2"
            >
              Browse the marketplace
            </a>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Wallet */}
      <Card fillClassName="bg-mint" shadow="sm">
        <div className="flex items-center justify-between">
          <span className="font-mono font-bold uppercase text-[12px] tracking-[0.08em] text-ink">Wallet</span>
          <span className="font-mono font-bold text-[18px] text-ink">
            {balance != null ? `${balance.toLocaleString()} AvaCoins` : '—'}
          </span>
        </div>
      </Card>

      {/* Tabs */}
      <div className="flex items-center gap-2">
        {(['upcoming', 'past'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={[
              'rounded-full border-zine border-ink px-4 py-2 font-mono font-bold uppercase text-[12px] tracking-[0.06em]',
              tab === t ? 'bg-lime text-ink shadow-zine-xs' : 'bg-card text-inkSoft',
            ].join(' ')}
          >
            {t}
          </button>
        ))}
      </div>

      {error && <p className="font-body font-bold text-[14px] text-coral">⚠ {error}</p>}

      {loading && !bookings ? (
        <div className="flex items-center gap-3 p-4">
          <Spinner size={22} />
          <span className="font-body font-bold text-[15px] text-inkSoft">Loading…</span>
        </div>
      ) : bookings && bookings.length ? (
        <div className="flex flex-col gap-3">
          {bookings.map((b) => (
            <TicketCard key={b.id} booking={b} past={tab === 'past'} />
          ))}
        </div>
      ) : (
        <Card fillClassName="bg-paper2">
          <p className="font-body font-bold text-[15px] text-inkSoft">
            {tab === 'upcoming' ? 'Nothing upcoming yet.' : 'No past bookings.'}{' '}
            <a href="/explore" className="text-blueInk underline decoration-blue decoration-2 underline-offset-2">
              Find something to book
            </a>
            .
          </p>
        </Card>
      )}
    </div>
  );
}

/** Hydrated dashboard island. Wrapped in ClerkIsland for live-session reads. */
export function MyBookings() {
  return (
    <ClerkIsland>
      <DashboardInner />
    </ClerkIsland>
  );
}

export default MyBookings;
