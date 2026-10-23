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
  events?: OrderEvent[]; liveQuote?: LiveQuote;
}
export interface AdminProduct {
  id: string; slug: string; title: string; description: string; status: 'pending' | 'live' | 'rejected' | 'hidden'; reviewNote: string | null;
  imageUrl: string | null; mockups: string[]; catalogName: string; colours: Array<{ name: string; hex: string }>;
  sizes: Array<{ size: string; basePaise: number; pricePaise: number; youEarnPaise: number }>; markupRupees: number; soldCount: number; publicUrl: string; createdAt: number;
  seller: { uid: string | null; slug: string | null; displayName: string | null }; moderation: string | null;
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
