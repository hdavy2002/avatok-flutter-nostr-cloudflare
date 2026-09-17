import { UiText } from "../../lib/i18n/react";
/* [BETA-TESTMODE-1 2026-09-14] The buyer-facing beta / test-mode notice.
 *
 * Shown ONLY when the gateway the buyer has actually selected reports
 * `test_mode: true` on GET /api/pay/methods. That field is derived server-side from
 * the rail's own credentials (worker/src/lib/payments/registry.ts →
 * GatewayAdapter.testMode), never from a platform flag: `razorpayEnabled` can be true
 * with LIVE keys, and telling a buyer "no real money will be charged" while a live key
 * is in place is the one mistake this component must never make. No selection, or a
 * live rail, renders nothing.
 *
 * The card details are Razorpay's own and are printed only for Razorpay. Another
 * gateway in test mode gets the notice without them rather than a card that belongs to
 * a different provider.
 *
 * Source: Razorpay Docs, "Test Cards Details to Test Payments and Subscriptions"
 * (razorpay.com/docs/payments/payments/test-card-details/, India) and "Test UPI ID
 * Details" (razorpay.com/docs/payments/payments/test-upi-details/), both read
 * 2026-09-14. NOTE: `4111 1111 1111 1111` + OTP `1111`, which older notes in this repo
 * carried, are NOT in Razorpay's current documentation — test mode now shows a mock
 * bank page with Success and Failure buttons instead of an OTP field. Re-read the docs
 * before changing anything here; do not restore the old numbers from memory.
 */
import { useEffect } from 'react';
import { Card } from '../../components/Card';
import { capture } from '../../lib/analytics';
import type { GatewayId } from './types';

const RAZORPAY_TEST_CARDS: readonly { network: string; number: string }[] = [
  { network: 'Visa', number: '4100 2800 0000 1007' },
  { network: 'Mastercard', number: '5555 5100 0008 1006' },
  { network: 'RuPay', number: '6527 6589 0000 1005' },
];

export interface BetaTestNoticeProps {
  gateway: GatewayId;
  listingId: string;
}

export function BetaTestNotice({ gateway, listingId }: BetaTestNoticeProps) {
  useEffect(() => {
    capture('checkout_beta_test_notice_shown', { gateway, listing_id: listingId });
  }, [gateway, listingId]);

  return (
    <Card fillClassName="bg-paper2">
      <p className="font-mono font-bold uppercase tracking-[0.1em] text-[11px] text-inkMute"><UiText id="web-checkout.f28c598d75d22878" source="Beta demonstration · test mode" />{" "}</p>
      <p className="mt-2 font-body font-bold text-[15px] text-ink"><UiText id="web-checkout.8874a37921d7a5f7" source="This is a beta demonstration. Payments are in test mode, and no real money will be charged. Please use the test payment details shown below." />{" "}</p>

      {gateway === 'razorpay' ? (
        <div className="mt-3 flex flex-col gap-2">
          <p className="font-body font-bold text-[14px] text-inkSoft"><UiText id="web-checkout.7d3479ea0027f506" source="Test card — use any random CVV and any future expiry date:" /></p>
          <ul className="flex flex-col gap-1">
            {RAZORPAY_TEST_CARDS.map((c) => (
              <li key={c.number} className="font-mono text-[14px] text-ink">
                <span className="text-inkMute">{c.network}</span> {c.number}
              </li>
            ))}
          </ul>
          <p className="font-body font-bold text-[14px] text-inkSoft"><UiText id="web-checkout.a439dc626ad5931e" source="On the mock bank page that follows, choose" />{" "}<strong><UiText id="web-checkout.c88a0b907419a70c" source="Success" /></strong>{" "}<UiText id="web-checkout.98096d74e91c3b23" source="to complete the payment or" />{' '}
            <strong><UiText id="web-checkout.7031edbcf9c42caa" source="Failure" /></strong>{" "}<UiText id="web-checkout.bb287cb9fef61b02" source="to see a declined payment." />{" "}</p>
          <p className="font-body font-bold text-[14px] text-inkSoft"><UiText id="web-checkout.d1d96629da3ee38a" source="Paying by UPI instead:" />{" "}<span className="font-mono text-ink">success@razorpay</span>{" "}<UiText id="web-checkout.4e59abe6d3bc5643" source="completes," />{' '}
            <span className="font-mono text-ink">failure@razorpay</span>{" "}<UiText id="web-checkout.7a6970b7e40bb7a8" source="declines." />{" "}</p>
        </div>
      ) : (
        <p className="mt-3 font-body font-bold text-[14px] text-inkSoft"><UiText id="web-checkout.a893466db9f72e15" source="This gateway is in its sandbox. Use the test details from that provider’s own documentation — Razorpay’s test cards will not work here." />{" "}</p>
      )}

      <p className="mt-3 font-body text-[13px] text-inkMute"><UiText id="web-checkout.687ac02b12ef2ed5" source="Nothing is charged and no booking is billed while this notice is showing." />{" "}</p>
    </Card>
  );
}

export default BetaTestNotice;
