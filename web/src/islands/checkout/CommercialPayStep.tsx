/* [WEB-COMM-PAY-1 / WEB-COMM-PAY-2] CommercialPayStep — the paid-session lane (SPEC §3).
 *
 * Replaces the legacy /api/calendar/book call for `live_event` and `consult` listings,
 * which never created the `commercial_entitlements` row the session join gate later
 * requires (the bug this workstream exists to fix — see SlotPicker.tsx).
 *
 * [WEB-COMM-PAY-2] CORRECTION. The previous pass modelled this as "create an order via
 * checkout, then pay for it" — waiting for a 402 to hand an `order_id` to the gateway
 * picker. That order id never existed: `commercial_checkout.ts:564` returns exactly
 * `{ error: 'insufficient_funds', needed }` on an empty wallet, nothing else. Per the
 * `[PAY-HANDOFF-1]` design in `commercial_checkout.ts`, the wallet lane and the gateway
 * lane are two INDEPENDENT funding rails into the same provisioning code:
 *
 *   wallet rail   — POST /api/commercial/{live|consult}/:id/checkout (debits the
 *                   balance; booking is already done on success; 402 with no order id
 *                   on an empty wallet — there is nothing to hand to a gateway)
 *   gateway rail  — POST /api/pay/:gateway/order { listingId, bookingId?, slot? }
 *                   (self-sufficient — mints its own order from the listing, per
 *                   pay.ts:110-236), then GET /api/pay/:gateway/status polls for the
 *                   webhook to provision via provisionFromGatewayPurchase.
 *
 * Both rails are offered side by side, gated on the same "I accept the cancellation
 * terms" checkbox, so a buyer with balance can pay instantly and a buyer without it
 * never has to bounce off a failed wallet attempt first.
 */
import { useEffect, useState } from 'react';
import { request, ApiError } from '../../lib/apiClient';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { Spinner } from '../../components/Spinner';
import { inr, inrOrFree, priceBreakdown } from '../../lib/money';
import { listingErrorMessage } from '../../lib/listingErrors';
import { GatewayPicker } from './GatewayPicker';
import type { Listing } from '../../lib/types';
import type { BookingResult, BookSelection, CommercialCheckoutNeedsFunding, CommercialCheckoutResult, PayStatusResponse, WalletBalance } from './types';

function uuidv4(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    })
  );
}

/** Best-effort, honest cancellation copy derived from the listing's own
 *  commercial_* attrs (the same fields commercial_checkout.ts's policyFor()
 *  reads server-side). Generic fallback text when an attr is missing, never a
 *  fabricated number. */
function policySummary(kind: 'live_event' | 'consult_1to1', attrs: Record<string, unknown>): string {
  if (kind === 'live_event') {
    const hrs = Number(attrs.commercial_refund_window_hours);
    if (Number.isFinite(hrs)) {
      return hrs > 0
        ? `Refundable up to ${hrs} hour${hrs === 1 ? '' : 's'} before the event starts. No refund after that, including a no-show.`
        : 'This ticket is non-refundable once purchased.';
    }
    return 'This ticket’s refund terms will be confirmed before you pay.';
  }
  const cancel = Number(attrs.commercial_cancellation_window_hours);
  const notice = Number(attrs.commercial_booking_notice_hours);
  const reschedule = attrs.commercial_reschedule_allowed === true;
  const parts: string[] = [];
  parts.push(
    Number.isFinite(cancel)
      ? cancel > 0
        ? `Cancel at least ${cancel} hour${cancel === 1 ? '' : 's'} ahead for a refund.`
        : 'This booking is non-refundable once confirmed.'
      : 'Cancellation terms will be confirmed before you pay.',
  );
  if (Number.isFinite(notice)) parts.push(`Bookings need at least ${notice}h notice.`);
  parts.push(reschedule ? 'Rescheduling is possible with the creator’s agreement.' : 'This booking can’t be rescheduled.');
  parts.push('A no-show is treated as the session having happened and is not refunded.');
  return parts.join(' ');
}

export interface CommercialPayStepProps {
  listing: Listing;
  selection: Extract<BookSelection, { type: 'commercial' }>;
  token: string;
  onBooked: (result: BookingResult) => void;
  onBack: () => void;
}

export function CommercialPayStep({ listing, selection, token, onBooked, onBack }: CommercialPayStepProps) {
  const [idemKey] = useState(uuidv4);
  // [WEB-COMM-PAY-2] Minted once per checkout attempt, reused on retry — mirrors the
  // Idempotency-Key discipline. Required so the gateway rail's webhook-driven provisioning
  // (provisionFromGatewayPurchase → commercial_checkout.ts:640) actually creates a
  // `bookings` row for a consult; without a bookingId on the order, that INSERT is
  // skipped entirely and the buyer pays with no bookable row. Null for a live ticket,
  // which has no booking concept.
  const [bookingId] = useState<string | null>(() =>
    selection.kind === 'consult_1to1' ? `web-consult-booking:${uuidv4()}` : null,
  );
  const [accepted, setAccepted] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [loadingBal, setLoadingBal] = useState(true);

  const attrs = (listing as unknown as { attrs?: Record<string, unknown> }).attrs ?? {};
  const baseTokens = Math.trunc(Number(selection.requiredCoins ?? listing.price ?? listing.effective_price ?? 0));
  const breakdown = priceBreakdown(baseTokens);
  const clientTotal = breakdown?.total ?? 0;
  const policyText = policySummary(selection.kind, attrs);

  useEffect(() => {
    void (async () => {
      setLoadingBal(true);
      try {
        const r = await request<WalletBalance>('/api/wallet/balance', { auth: token });
        setBalance(Math.trunc(Number(r.balance ?? 0)));
      } catch {
        setBalance(null); // unknown — the wallet button still allows the attempt
      } finally {
        setLoadingBal(false);
      }
    })();
  }, [token]);

  const walletInsufficient = balance != null && clientTotal > 0 && balance < clientTotal;

  async function payFromWallet() {
    if (!accepted || walletBusy) return;
    setWalletBusy(true);
    setWalletError(null);
    try {
      const pathKind = selection.kind === 'live_event' ? 'live' : 'consult';
      const result = await request<CommercialCheckoutResult>(
        `/api/commercial/${pathKind}/${encodeURIComponent(selection.listingId)}/checkout`,
        {
          method: 'POST',
          auth: token,
          headers: { 'Idempotency-Key': idemKey },
          body: {
            accept_policy: true,
            ...(selection.slot ? { slot: selection.slot } : {}),
          },
        },
      );
      const charged = result.amount_coins ?? result.charged_amount ?? result.gross_amount ?? baseTokens;
      onBooked({
        ok: true,
        booking_id: result.booking_id ?? result.order_id,
        start_at: result.starts_at ?? undefined,
        end_at: result.ends_at ?? undefined,
        paid: charged > 0,
        escrow_coins: charged > 0 ? charged : undefined,
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) {
        // [WEB-COMM-PAY-2] No order_id ever arrives here — see the file header. This is
        // a dead end for the wallet rail, not a handoff; point the buyer at the gateway
        // picker instead of waiting for something the server will never send.
        const body = (e.body ?? {}) as CommercialCheckoutNeedsFunding;
        const needed = Math.trunc(Number(body.needed ?? clientTotal));
        setWalletError(
          `Your Token balance can’t cover this${Number.isFinite(needed) && needed > 0 ? ` (need ${inr(needed)})` : ''}. No charge was made — pay by card or UPI below instead.`,
        );
      } else if (e instanceof ApiError) {
        setWalletError(listingErrorMessage(e.error, e.body && typeof e.body === 'object' ? (e.body as { message?: unknown }).message : undefined));
      } else {
        setWalletError('That didn’t go through. Please try again.');
      }
    } finally {
      setWalletBusy(false);
    }
  }

  function onGatewayPaid(status: PayStatusResponse) {
    onBooked({
      ok: true,
      booking_id: bookingId ?? status.order_id,
      paid: true,
      escrow_coins: status.total_amount ?? clientTotal,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="font-mono font-bold uppercase text-[14px] tracking-[0.08em] text-inkSoft">
              You’re booking
            </span>
            <Pill kind="plain">{selection.title}</Pill>
          </div>
          {breakdown ? (
            <>
              <div className="flex items-center justify-between border-t-zine border-inkMute pt-3">
                <span className="font-body font-bold text-[14px] text-inkSoft">Price</span>
                <span className="font-mono font-bold text-[14px] text-ink">{inr(breakdown.base)}</span>
              </div>
              {breakdown.fee > 0 && (
                <div className="flex items-center justify-between">
                  <span className="font-body font-bold text-[14px] text-inkSoft">Platform fee</span>
                  <span className="font-mono font-bold text-[14px] text-ink">{inr(breakdown.fee)}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="font-body font-bold text-[14px] text-inkSoft">GST ({breakdown.gstRatePct}%)</span>
                <span className="font-mono font-bold text-[14px] text-ink">{inr(breakdown.gst)}</span>
              </div>
              <div className="flex items-center justify-between border-t-zine border-inkMute pt-3">
                <span className="font-display font-semibold text-[16px] text-ink">Total</span>
                <span className="font-mono font-bold text-[16px] text-ink">{inr(breakdown.total)}</span>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between border-t-zine border-inkMute pt-3">
              <span className="font-display font-semibold text-[16px] text-ink">Price</span>
              <span className="font-mono font-bold text-[15px] text-ink">{inrOrFree(baseTokens)}</span>
            </div>
          )}
        </div>
      </Card>

      <Card fillClassName="bg-paper2" shadow="sm">
        <p className="font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-inkSoft">Cancellation terms</p>
        <p className="mt-1 font-body font-bold text-[14px] text-ink">{policyText}</p>
      </Card>

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => setAccepted(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 rounded border-zine border-ink"
        />
        <span className="font-body font-bold text-[14px] text-ink">
          I’ve read and agree to the cancellation terms above.
        </span>
      </label>

      {/* Wallet rail — POST /api/commercial/{live|consult}/:id/checkout. Fastest path for
          a returning buyer with balance; unchanged behaviour from before this correction. */}
      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="font-display font-semibold text-[16px] text-ink">Pay from wallet</span>
            <span className="font-mono font-bold text-[15px] text-mintInk">
              {loadingBal ? <Spinner size={16} /> : balance != null ? `${balance.toLocaleString()} Tokens` : '—'}
            </span>
          </div>
          {walletError && <p className="font-body font-bold text-[14px] text-coral">⚠ {walletError}</p>}
          <Button
            variant="lime"
            fullWidth
            loading={walletBusy}
            disabled={!accepted || walletInsufficient}
            label={
              walletInsufficient
                ? 'Not enough balance'
                : breakdown
                  ? `Pay ${inr(breakdown.total)} from balance`
                  : 'Confirm booking'
            }
            onClick={() => void payFromWallet()}
          />
        </div>
      </Card>

      {/* Gateway rail — POST /api/pay/:gateway/order, self-sufficient. Offered side by
          side with the wallet, not as a fallback the buyer waits for a 402 to reach. */}
      <div className="flex flex-col gap-3">
        <p className="font-mono font-bold uppercase text-[13px] tracking-[0.08em] text-inkSoft">
          Or pay by card / UPI
        </p>
        <GatewayPicker
          token={token}
          listingId={selection.listingId}
          kind={selection.kind}
          bookingId={bookingId}
          slot={selection.slot}
          clientTotalCoins={clientTotal}
          disabled={!accepted}
          onPaid={onGatewayPaid}
        />
      </div>

      <button
        type="button"
        className="font-mono font-bold uppercase text-[14px] tracking-[0.06em] text-blueInk underline decoration-blue decoration-2 underline-offset-2 disabled:text-inkMute"
        disabled={walletBusy}
        onClick={onBack}
      >
        ← Back
      </button>
    </div>
  );
}

export default CommercialPayStep;
