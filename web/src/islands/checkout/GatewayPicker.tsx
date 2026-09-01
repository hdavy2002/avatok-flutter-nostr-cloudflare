/* [WEB-COMM-PAY-1 / WEB-COMM-PAY-2] GatewayPicker — SPEC §3.3, corrected per the
 * [PAY-HANDOFF-1] design in worker/src/routes/commercial_checkout.ts and
 * worker/src/routes/pay.ts: the wallet lane (`POST .../checkout`) and the gateway lane
 * are two INDEPENDENT funding rails into the same provisioning code, not "create an
 * order, then pay for it". `POST /api/pay/:gateway/order` is self-sufficient — it takes
 * `{ listingId, bookingId?, slot? }` and computes the price from the listing itself
 * (pay.ts:110-236). This component therefore creates its OWN order the moment the buyer
 * picks a gateway and hits Pay; it is never handed an order id from a 402 (there never
 * was one to hand — commercial_checkout.ts:564 returns `{ error, needed }`, nothing else).
 *
 * Reads GET /api/pay/methods and renders whatever comes back side by side, in the order
 * given, with NONE preselected (owner decision — the buyer picks every time). The Pay
 * button stays disabled until they choose. An empty list is today's real production
 * state (no gateway configured yet) and renders as "Payments aren't open yet", not as
 * an error.
 *
 * The total shown here starts as the caller's own estimate (`clientTotalCoins`, from
 * `priceBreakdown()` in money.ts) and is cross-checked against the server's own number
 * the moment the order is created. If they disagree, this shows the SERVER'S number and
 * refuses to open the gateway sheet — never charge a number the buyer did not see.
 */
import { useEffect, useRef, useState } from 'react';
import { request, ApiError } from '../../lib/apiClient';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Spinner } from '../../components/Spinner';
import { inr } from '../../lib/money';
import { listingErrorMessage } from '../../lib/listingErrors';
import { openGatewaySheet, createStripeElements, confirmStripePayment } from './gatewaySheet';
import { stashPayReturn } from './PayReturn';
import type { StripeElementsHandle } from './gatewaySheet';
import type { GatewayId, GatewayOrderResponse, PayMethod, PayMethodsResponse, PayStatusResponse } from './types';

const POLL_MS = 2500;
const POLL_ATTEMPTS = 24; // ~60s

export interface GatewayPickerProps {
  token: string;
  listingId: string;
  kind: 'live_event' | 'consult_1to1';
  /** Only for `consult_1to1` — a stable id minted once per checkout attempt by the
   *  caller (CommercialPayStep.tsx). `provisionFromGatewayPurchase` only creates a
   *  `bookings` row when this is present (commercial_checkout.ts:640) — omit it for a
   *  consult and the buyer pays but never gets a bookable row. Null for `live_event`,
   *  which has no booking concept. */
  bookingId: string | null;
  /** The selected slot for a consult, `null` for a live ticket. */
  slot: { start_at: number; end_at: number } | null;
  /** What the client computed before asking the server — only used to detect drift. */
  clientTotalCoins: number | null;
  /** Gated on the parent's "I accept the cancellation terms" checkbox. */
  disabled?: boolean;
  onPaid: (status: PayStatusResponse) => void;
}

type Phase = 'pick' | 'opening' | 'stripe-form' | 'polling' | 'timeout';

export function GatewayPicker({
  token,
  listingId,
  kind,
  bookingId,
  slot,
  clientTotalCoins,
  disabled,
  onPaid,
}: GatewayPickerProps) {
  const [methods, setMethods] = useState<PayMethod[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GatewayId | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>('pick');
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<GatewayOrderResponse | null>(null);
  const [stripeHandle, setStripeHandle] = useState<StripeElementsHandle | null>(null);
  const stripeContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await request<PayMethodsResponse>('/api/pay/methods', { auth: token });
        setMethods(r.methods ?? []);
      } catch (e) {
        setLoadError(e instanceof ApiError ? e.error : 'Could not load payment methods.');
        setMethods([]);
      }
    })();
  }, [token]);

  // Mount the Stripe Payment Element once its container exists in the DOM.
  useEffect(() => {
    if (phase !== 'stripe-form' || !stripeHandle || !stripeContainerRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paymentElement = (stripeHandle.elements as any).create('payment');
    paymentElement.mount(stripeContainerRef.current);
    return () => {
      try {
        paymentElement.unmount();
      } catch {
        /* container already gone */
      }
    };
  }, [phase, stripeHandle]);

  async function pollStatus(gateway: GatewayId, orderId: string, attempt = 0): Promise<void> {
    if (attempt >= POLL_ATTEMPTS) {
      setPhase('timeout');
      return;
    }
    setPhase('polling');
    try {
      const s = await request<PayStatusResponse>(`/api/pay/${gateway}/status`, {
        auth: token,
        query: { order_id: orderId },
      });
      if (s.status === 'paid') {
        onPaid(s);
        return;
      }
      if (s.status === 'failed' || s.status === 'refunded') {
        setBusy(false);
        setPhase('pick');
        setError('That payment did not go through. No charge was made — try again or pick another method.');
        return;
      }
    } catch {
      /* transient — keep polling until the attempt budget runs out */
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    return pollStatus(gateway, orderId, attempt + 1);
  }

  async function pay() {
    if (!selected || busy || disabled) return;
    setBusy(true);
    setError(null);
    setPhase('opening');
    try {
      const created = await request<GatewayOrderResponse>(`/api/pay/${selected}/order`, {
        method: 'POST',
        auth: token,
        body: {
          listingId,
          ...(bookingId ? { bookingId } : {}),
          ...(slot ? { slot } : {}),
        },
      });

      const serverTotal = created.total_amount ?? Math.round(created.amount_paise / 100);
      if (clientTotalCoins != null && Number.isFinite(clientTotalCoins) && clientTotalCoins !== serverTotal) {
        setBusy(false);
        setPhase('pick');
        setError(
          `The price changed since you started checkout. You’d be charged ${inr(serverTotal)}, not ${inr(clientTotalCoins)}. Review the price above and try again.`,
        );
        return;
      }

      setOrder(created);

      if (selected === 'stripe') {
        const handle = await createStripeElements(created);
        if ('error' in handle) throw new Error(handle.error);
        setStripeHandle(handle);
        setPhase('stripe-form');
        setBusy(false);
        return;
      }

      await openGatewaySheet(selected, created, {
        onSettled: () => void pollStatus(selected, created.order_id),
        onDismiss: () => {
          setBusy(false);
          setPhase('pick');
        },
        onError: (message) => {
          setBusy(false);
          setPhase('pick');
          setError(message);
        },
        // Paytm (today; any future redirect-based gateway) navigates away before
        // any of the callbacks above can fire. Persist what /pay/return needs
        // while this page still exists — the query string it comes back with is
        // still the source of truth for gateway/order_id, this is only the
        // "back to the listing on failure" nicety (see PayReturn.tsx header).
        onRedirecting: () => {
          stashPayReturn({ gateway: selected, orderId: created.order_id, listingId });
        },
      });
    } catch (e) {
      setBusy(false);
      setPhase('pick');
      setError(
        e instanceof ApiError ? listingErrorMessage(e.error) : e instanceof Error ? e.message : 'Could not start that payment. Try again.',
      );
    }
  }

  async function confirmStripe() {
    if (!stripeHandle || !order || busy) return;
    setBusy(true);
    setError(null);
    const result = await confirmStripePayment(stripeHandle, window.location.href);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    void pollStatus('stripe', order.order_id);
  }

  function backToPick() {
    setPhase('pick');
    setOrder(null);
    setStripeHandle(null);
    setError(null);
    setBusy(false);
  }

  if (methods === null) {
    return (
      <div className="flex items-center gap-3 p-4">
        <Spinner size={22} />
        <span className="font-body font-bold text-[15px] text-inkSoft">Loading payment options…</span>
      </div>
    );
  }

  const displayTotal = order?.total_amount ?? clientTotalCoins ?? null;

  if (phase === 'stripe-form') {
    return (
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex items-center justify-between">
            <span className="font-display font-semibold text-[16px] text-ink">Total to pay</span>
            <span className="font-mono font-bold text-[16px] text-ink">{inr(displayTotal)}</span>
          </div>
        </Card>
        <div ref={stripeContainerRef} />
        {error && (
          <Card fillClassName="bg-paper2" shadow="sm">
            <p className="font-body font-bold text-[14px] text-coral">⚠ {error}</p>
          </Card>
        )}
        <Button
          variant="lime"
          fullWidth
          loading={busy}
          label={`Pay ${inr(displayTotal)}`}
          onClick={() => void confirmStripe()}
        />
        <button
          type="button"
          className="font-mono font-bold uppercase text-[14px] tracking-[0.06em] text-blueInk underline decoration-blue decoration-2 underline-offset-2 disabled:text-inkMute"
          disabled={busy}
          onClick={backToPick}
        >
          ← Choose a different payment method
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex items-center justify-between">
          <span className="font-display font-semibold text-[16px] text-ink">Total to pay</span>
          <span className="font-mono font-bold text-[16px] text-ink">{inr(displayTotal)}</span>
        </div>
      </Card>

      {loadError && (
        <Card fillClassName="bg-paper2" shadow="sm">
          <p className="font-body font-bold text-[14px] text-coral">⚠ {loadError}</p>
        </Card>
      )}

      {!loadError && methods.length === 0 ? (
        <Card fillClassName="bg-paper2">
          <p className="font-body font-bold text-[15px] text-inkSoft">
            Payments aren’t open yet. Check back soon — this booking is held for you in the meantime.
          </p>
        </Card>
      ) : (
        <div role="radiogroup" aria-label="Payment method" className="flex flex-col gap-3">
          {methods.map((m) => {
            const isSelected = selected === m.gateway;
            return (
              <button
                key={m.gateway}
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={busy || disabled}
                onClick={() => setSelected(m.gateway)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelected(m.gateway);
                  }
                }}
                className={[
                  'flex items-center justify-between gap-3 rounded-zine border-zine p-[18px] text-left',
                  'transition-transform duration-zine ease-out',
                  'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-blue',
                  'disabled:opacity-60',
                  isSelected ? 'border-ink bg-lime shadow-zine-sm' : 'border-ink bg-card shadow-zine-xs',
                ].join(' ')}
              >
                <span className="flex flex-col gap-1">
                  <span className="font-display font-semibold text-[17px] text-ink">{m.label}</span>
                  <span className="font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-inkSoft">
                    {m.sub}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className={[
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-zine border-ink',
                    isSelected ? 'bg-ink' : 'bg-card',
                  ].join(' ')}
                >
                  {isSelected && <span className="h-2.5 w-2.5 rounded-full bg-lime" />}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <Card fillClassName="bg-paper2" shadow="sm">
          <p className="font-body font-bold text-[14px] text-coral">⚠ {error}</p>
        </Card>
      )}

      {(phase === 'opening' || phase === 'polling') && (
        <div className="flex items-center gap-3 p-2">
          <Spinner size={20} />
          <span className="font-body font-bold text-[14px] text-inkSoft">
            {phase === 'opening' ? 'Opening payment window…' : 'Confirming your payment…'}
          </span>
        </div>
      )}

      {phase === 'timeout' && (
        <Card fillClassName="bg-paper2" shadow="sm">
          <p className="font-body font-bold text-[14px] text-inkSoft">
            This is taking longer than usual. If the money left your account, your booking will confirm shortly —
            check My Bookings. If nothing was charged, it’s safe to try again — please don’t pay twice for the same
            booking.
          </p>
          <div className="mt-3">
            <Button variant="blue" label="Try again" onClick={backToPick} />
          </div>
        </Card>
      )}

      <Button
        variant="lime"
        fullWidth
        loading={busy}
        disabled={!selected || disabled || methods.length === 0}
        label={displayTotal != null ? `Pay ${inr(displayTotal)}` : 'Pay'}
        onClick={() => void pay()}
      />
    </div>
  );
}

export default GatewayPicker;
