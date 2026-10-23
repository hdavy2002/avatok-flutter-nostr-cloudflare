/* merchKit — [HF-MERCH-ADMIN-1] Shared types, API wrapper, telemetry and tiny UI bits for the four Merch admin screens.
 * Worker contract: worker/src/routes/admin2_merch.ts (Specs/SPEC-2026-10-23-HF-MERCH.md sections 5 and 11). Money on the wire is paise.
 * No silent catches: every failure is captured to PostHog and shown on screen. Nothing under 14px. */
import { useEffect, type ReactNode } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { adminCall } from '../peopleKit';
import { errBody, errCode, errMessage, formatPaise } from '../adminApi';
import './merch.css';

export { adminCall, formatPaise, errBody, errCode };

export const money = (paise: number | null | undefined) => formatPaise(paise);
export const dateIST = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '—';

export interface MerchMoney {
  qty: number; baseUnitPaise: number; markupUnitPaise: number; unitPaise: number; basePaise: number; markupPaise: number; totalPaise: number;
  influencerPaise: number; platformPaise: number; shareBps: number; payMethod: 'wallet' | 'cashfree';
  cashfreeFeeBps: number; cashfreeFeeEstPaise: number; gstBps: number; gstEstPaise: number; platformNetPaise: number;
}
export interface MerchSnap {
  title?: string; imageUrl?: string | null; hostName?: string; hostSlug?: string; productSlug?: string; catalogName?: string; colour?: string; size?: string; qty?: number;
  side?: string; money?: MerchMoney; payMethod?: string;
}
export interface LiveQuote {
  quoteAvailable?: boolean; liveBasePaise?: number; platformNetAfterPaise?: number; costRose: boolean; canApprove: boolean; risePaise?: number; stale?: boolean; source?: string;
  message?: string; canForce?: boolean;
}
export interface OrderEvent { at: number; kind: string; actor: string | null; note: string | null }
export interface AdminOrder {
  id: string; orderNo: string; createdAt: number; confirmedAt: number | null; status: string; sellerStatus: string; payStatus: string; payMethod: string | null;
  reference: string | null; totalPaise: number;
  buyer: { uid: string; name: string; phone: string; email: string | null; address: { name?: string; phone?: string; line1?: string; line2?: string; city?: string; state?: string; pincode?: string } };
  merch: MerchSnap; seller: { uid: string | null; slug: string | null; displayName: string | null };
  approval: { status: string; by: string | null; at: number | null; rejectReason: string | null };
  fulfilment: {
    status: string; partner: { provider?: string; provider_order_id?: string; status?: string; last_error?: string | null; attempts?: number } | null; partnerRef: string | null;
    courier: string | null; awb: string | null; trackingUrl: string | null; sentToPrinterAt: number | null; shippedAt: number | null; deliveredAt: number | null;
  };
  refund: { status: 'none' | 'done' | 'pending_manual' | 'refunding'; at: number | null }; earningCreditedAt: number | null;
  problem: { kind?: string; note?: string; at?: number; photoUrl: string | null } | null;
  events?: OrderEvent[]; liveQuote?: LiveQuote; profit?: ProfitBlock | null;
}
export interface ProfitRow {
  size: string; printroveCostPaise: number; shippingPaise: number; printroveTotalPaise: number; fanPaysPaise: number; influencerPaise: number;
  platformBeforeFeesPaise: number; gstEstPaise: number; cashfreeEstPaise: number; platformAfterFeesPaise: number;
}
export interface ProfitBlock { shippingPaise: number; rows: ProfitRow[]; live: boolean; note?: string }
export interface AdminProduct {
  id: string; slug: string; title: string; description: string; status: 'pending' | 'live' | 'rejected' | 'hidden'; reviewNote: string | null;
  imageUrl: string | null; mockups: string[]; catalogName: string; colours: Array<{ name: string; hex: string }>;
  sizes: Array<{ size: string; basePaise: number; pricePaise: number; youEarnPaise: number }>; markupRupees: number; soldCount: number; publicUrl: string; createdAt: number;
  seller: { uid: string | null; slug: string | null; displayName: string | null }; moderation: string | null; profit?: ProfitBlock | null;
}
export interface MerchSettings {
  hfMerchEnabled: boolean; hfMerchCheckoutEnabled: boolean; hfMerchAutoApprove: boolean; hfMerchProductReview: boolean;
  hfMerchPlatformShareBps: number; hfMerchMinMarkupRupees: number; hfMerchBaseBufferRupees: number; hfMerchCashfreeFeeBps: number; hfMerchGstBps: number; hfMerchHoldDays: number;
}

/** One admin page view per mount: merch_admin_page_viewed {page}. */
export function usePageView(page: string): void {
  useEffect(() => { capture('merch_admin_page_viewed', { page }); }, [page]);
}
/** Click telemetry (merch_order_approved_clicked, merch_product_review_clicked …). */
export function click(event: string, props: Record<string, unknown> = {}): void { capture(event, props); }

/** Failure path: PostHog $exception + a calm on-screen message. Returns the text to show. */
export function fail(action: string, err: unknown, props: Record<string, unknown> = {}): string {
  captureException(err, { where: 'merch_admin', action, ...props });
  capture('merch_admin_error', { action, code: errCode(err) ?? null, ...props });
  return errMessage(err, 'That did not work. Please try again.');
}

export function Banner({ tone, children }: { tone: 'error' | 'info' | 'warn'; children: ReactNode }) {
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`mx-banner ${tone}`}>{children}</div>;
}
export function Empty({ children }: { children: ReactNode }) { return <p className="mx-empty">{children}</p>; }

export const REASONS = [
  'The print file could not be printed',
  'The item is out of stock',
  'The delivery address cannot be served',
  'Printing cost went up too much',
  'The fan asked to cancel',
  'The item arrived wrong or damaged',
] as const;
export const OTHER = 'Other (write below)';

/** Rupees from paise: whole rupees when whole, else 2 decimals (₹267.75). */
export const rupees = (paise: number): string => {
  const neg = paise < 0, a = Math.abs(paise), w = Math.trunc(a / 100), f = a % 100;
  return `${neg ? '−' : ''}₹${w.toLocaleString('en-IN')}${f ? `.${String(f).padStart(2, '0')}` : ''}`;
};
/** [HF-MERCH-PROFIT-VIEW-1] What the platform makes, per size. Red below ₹0 after fees, amber below ₹20. */
export function ProfitTable({ profit }: { profit: ProfitBlock | null | undefined }) {
  if (!profit || !profit.rows.length) return <p className="hfa-note">The money table is not available for this one.</p>;
  return (
    <div>
      {profit.note && <div className="mx-warn" role="status" style={{ marginBottom: 8 }}>{profit.note}</div>}
      <div className="mx-scroll"><table className="mx-table mx-profit">
        <thead><tr>
          <th>Size</th><th className="n">Printrove cost</th><th className="n">+ shipping</th><th className="n">Printrove total</th><th className="n">Fan pays</th>
          <th className="n">Influencer gets</th><th className="n">Platform keeps (before fees)</th><th className="n">Fees</th><th className="n">Platform keeps (after fees)</th>
        </tr></thead>
        <tbody>{profit.rows.map((r) => {
          const tone = r.platformAfterFeesPaise < 0 ? 'bad' : r.platformAfterFeesPaise < 2000 ? 'amber' : '';
          return (
            <tr key={r.size} className={tone ? `mx-p-${tone}` : undefined}>
              <td>{r.size}</td><td className="n">{rupees(r.printroveCostPaise)}</td><td className="n">{rupees(r.shippingPaise)}</td><td className="n">{rupees(r.printroveTotalPaise)}</td>
              <td className="n">{rupees(r.fanPaysPaise)}</td><td className="n">{rupees(r.influencerPaise)}</td><td className="n">{rupees(r.platformBeforeFeesPaise)}</td>
              <td className="n">{rupees(r.gstEstPaise + r.cashfreeEstPaise)}<span className="mx-fee">GST {rupees(r.gstEstPaise)}{r.cashfreeEstPaise > 0 ? ` + Cashfree ${rupees(r.cashfreeEstPaise)} if paid by UPI/card` : ''}</span></td>
              <td className="n"><b>{rupees(r.platformAfterFeesPaise)}</b></td>
            </tr>
          );
        })}</tbody>
      </table></div>
      <p className="hfa-note">Printrove cost = shirt + print + Printrove GST, as on Printrove’s dashboard. Shipping = Printrove’s current quote. Fees = GST on our share + Cashfree fee if the fan pays by UPI/card.</p>
    </div>
  );
}
