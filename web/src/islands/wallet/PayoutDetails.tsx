/* [HF-PAYOUT-CARD] "Payout details" card body (owner 2026-10-29): where withdrawals are paid. Replaces the old /hosts/onboarding?step=payout
 * wizard step. Same worker API as the app and the Withdraw card (rulebook HF-UPI-ONLY-1: UPI only, no bank account or IFSC):
 *   GET /api/hf/payouts/summary  -> upi { vpa, nameMatched } (shown masked), kycStatus
 *   PUT /api/hf/payouts/upi {vpa} -> add / change the UPI ID
 * The page puts it in a card with id="payout-details"; links (Withdraw, /hosts/onboarding?step=payout) land on that anchor.
 * Data loads after the page paints, so the anchor is scrolled to once the card is on screen. */
import { useEffect, useRef } from 'react';
import UpiSetup from './UpiSetup';

export const PAYOUT_DETAILS_ID = 'payout-details';

export default function PayoutDetails({ skin, next, where }: { skin: 'h3' | 'hfc'; next: string; where: 'wallet' | 'earnings' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      if (window.location.hash !== `#${PAYOUT_DETAILS_ID}`) return;
      const t = window.setTimeout(() => { (document.getElementById(PAYOUT_DETAILS_ID) ?? ref.current)?.scrollIntoView({ block: 'start' }); }, 60);
      return () => window.clearTimeout(t);
    } catch { /* ignore */ }
  }, []);
  return <div ref={ref} style={{ display: 'grid', gap: 10 }}>
    <p className="small muted" style={{ margin: 0 }}>Withdrawals are paid only to a UPI ID in your own name. No bank account number or IFSC is needed.</p>
    <UpiSetup where={where} skin={skin} next={next} />
  </div>;
}
