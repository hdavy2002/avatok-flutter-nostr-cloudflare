/* Phase B — PayStep (the "pay" step).
 *
 * Money is sensitive: we show EXACT amounts, never auto-retry a charge, and
 * surface failures plainly. We only drive the EXISTING flow:
 *   • balance  → GET  /api/wallet/balance        (coins; 1 coin = 1 cent)
 *   • top-up   → POST /api/wallet/topup { amountUsdCents }  → Stripe checkout_url
 *                (settlement is server-side via /webhooks/stripe — not our job)
 *   • book     → POST /api/calendar/book { slot_id }     (consult/event/live)
 *                POST /api/avavoice/bookings { ... }      (agent)
 *
 * We do NOT build a payment system. AvaCoins are the booking currency; if the
 * wallet can't cover a priced booking we send the user to Stripe top-up first.
 */
import { useEffect, useState } from 'react';
import { request, ApiError } from '../../lib/apiClient';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { Spinner } from '../../components/Spinner';
import type { BookSelection, BookingResult, TopupResult, WalletBalance } from './types';

function usd(coins: number): string {
  return `$${(coins / 100).toFixed(2)}`;
}

export interface PayStepProps {
  selection: BookSelection;
  token: string;
  onBooked: (result: BookingResult) => void;
  onBack: () => void;
}

export function PayStep({ selection, token, onBooked, onBack }: PayStepProps) {
  const [balance, setBalance] = useState<number | null>(null);
  const [loadingBal, setLoadingBal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when a priced booking exceeds the wallet — coins the user must add. */
  const [shortfall, setShortfall] = useState<number | null>(null);

  // requiredCoins is known for calendar slots; null (escrow) for agents.
  const required = selection.requiredCoins;

  useEffect(() => {
    void (async () => {
      setLoadingBal(true);
      try {
        const r = await request<WalletBalance>('/api/wallet/balance', { auth: token });
        const bal = Math.trunc(Number(r.balance ?? 0));
        setBalance(bal);
        if (required != null && required > 0 && bal < required) setShortfall(required - bal);
      } catch {
        setBalance(null); // unknown — we still allow the attempt
      } finally {
        setLoadingBal(false);
      }
    })();
  }, [token, required]);

  async function startTopup(coins: number) {
    setBusy(true);
    setError(null);
    try {
      const r = await request<TopupResult>('/api/wallet/topup', {
        method: 'POST',
        auth: token,
        body: { amountUsdCents: coins },
      });
      // Hand off to Stripe Checkout (settlement is server-side).
      window.location.href = r.checkout_url;
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        setError('Top-ups aren’t enabled yet — money-in is pending final approval. Hang tight.');
      } else {
        setError(e instanceof ApiError ? e.error : 'Could not start the top-up. Try again.');
      }
      setBusy(false);
    }
  }

  async function confirmBooking() {
    setBusy(true);
    setError(null);
    try {
      let result: BookingResult;
      if (selection.type === 'calendar') {
        result = await request<BookingResult>('/api/calendar/book', {
          method: 'POST',
          auth: token,
          body: { slot_id: selection.slotId },
        });
      } else {
        result = await request<BookingResult>('/api/avavoice/bookings', {
          method: 'POST',
          auth: token,
          body: {
            agent_id: selection.agentId,
            minutes: selection.minutes,
            scheduled_at: selection.scheduledAt,
            language: selection.language,
          },
        });
      }
      onBooked(result);
    } catch (e) {
      if (e instanceof ApiError) {
        // Insufficient funds (402): agent returns `needed`; calendar = payment failed.
        if (e.status === 402) {
          const needed =
            (e.body && typeof e.body === 'object' && 'needed' in e.body
              ? Math.trunc(Number((e.body as { needed?: unknown }).needed))
              : required) ?? null;
          const gap = needed != null && balance != null ? Math.max(needed - balance, needed) : needed;
          setShortfall(gap ?? null);
          setError('Not enough AvaCoins to cover this booking. Add coins to continue.');
        } else if (e.status === 409) {
          setError('That time was just taken (or you’ve already booked it). Pick another slot.');
        } else if (e.status === 425) {
          setError('It’s too early to start this session. You can still book it for later.');
        } else if (e.status === 403) {
          setError('You’re not able to book this one.');
        } else {
          setError(e.error || 'Booking failed. No charge was made.');
        }
      } else {
        setError('Booking failed. No charge was made.');
      }
      setBusy(false);
    }
  }

  const priceLine =
    required != null
      ? required > 0
        ? `${required.toLocaleString()} AvaCoins (${usd(required)})`
        : 'Free'
      : 'Pay-as-you-go (escrow held)';

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="font-mono font-bold uppercase text-[12px] tracking-[0.08em] text-inkSoft">
              You’re booking
            </span>
            <Pill kind="plain">{selection.title}</Pill>
          </div>
          <div className="flex items-center justify-between border-t-zine border-inkMute pt-3">
            <span className="font-display font-semibold text-[16px] text-ink">Price</span>
            <span className="font-mono font-bold text-[15px] text-ink">{priceLine}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-display font-semibold text-[16px] text-ink">Wallet</span>
            <span className="font-mono font-bold text-[15px] text-mintInk">
              {loadingBal ? <Spinner size={16} /> : balance != null ? `${balance.toLocaleString()} AvaCoins` : '—'}
            </span>
          </div>
        </div>
      </Card>

      {error && (
        <Card fillClassName="bg-paper2" shadow="sm">
          <p className="font-body font-bold text-[14px] text-coral">⚠ {error}</p>
        </Card>
      )}

      {shortfall != null && shortfall > 0 ? (
        <Button
          variant="lime"
          fullWidth
          loading={busy}
          label={`Add ${shortfall.toLocaleString()} AvaCoins (${usd(shortfall)})`}
          onClick={() => void startTopup(shortfall)}
        />
      ) : (
        <Button
          variant="lime"
          fullWidth
          loading={busy}
          disabled={loadingBal}
          label={required && required > 0 ? `Pay & confirm — ${usd(required)}` : 'Confirm booking'}
          onClick={() => void confirmBooking()}
        />
      )}

      <button
        type="button"
        className="font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-blueInk underline decoration-blue decoration-2 underline-offset-2 disabled:text-inkMute"
        disabled={busy}
        onClick={onBack}
      >
        ← Back
      </button>
    </div>
  );
}

export default PayStep;
