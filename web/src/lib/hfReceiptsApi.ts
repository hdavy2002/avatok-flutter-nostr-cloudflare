/* [HF-WALLET-LIMITS-1] Receipts client. Worker: GET /api/hf/wallet/receipts, GET /api/hf/wallet/receipts/:id (printable HTML, bearer-auth so it is
 * fetched and shown in a new tab rather than linked). */
import { API_BASE } from './env';
import { hfCall, type HfResult } from './hfCallsApi';
import { captureException } from './analytics';
import { consistentGstPaise } from './money';

export interface ReceiptItem { id: string; number: string; kind: 'receipt' | 'tax_invoice'; source: string; amountRupees: number; issuedAt: number;
  /** [HF-STD-PLAN-1] top-up split in paise (top level, or inside `data`): total paid, GST included, added to the wallet. */
  paidPaise?: number; gstPaise?: number; walletPaise?: number; data?: { paidPaise?: number; gstPaise?: number; walletPaise?: number } }
/** The three-way split of a receipt, or null for older receipts without it. */
export function receiptSplit(r: ReceiptItem): { paid: number; gst: number; wallet: number } | null {
  const paid = r.paidPaise ?? r.data?.paidPaise, gst = r.gstPaise ?? r.data?.gstPaise, wallet = r.walletPaise ?? r.data?.walletPaise;
  return paid != null && gst != null && wallet != null ? { paid, gst: consistentGstPaise(paid, gst, wallet), wallet } : null;
}
export interface ReceiptList { ok: boolean; invoicing: boolean; receipts: ReceiptItem[] }
export const fetchReceipts = (): Promise<HfResult<ReceiptList>> => hfCall<ReceiptList>('GET', '/api/hf/wallet/receipts');

export type OpenReceiptResult = 'ok' | 'popup_blocked' | 'failed';
/** Opens the printable page in a new tab. The tab is opened first (inside the tap) so pop-up blockers allow it. 'popup_blocked' only when the
 * browser refused the tab; any fetch/HTTP failure is 'failed' (and reported). */
export async function openReceipt(id: string): Promise<OpenReceiptResult> {
  const tab = window.open('', '_blank');
  if (!tab) return 'popup_blocked';
  const fail = (e: unknown): OpenReceiptResult => { try { tab.close(); } catch { /* ignore */ } captureException(e instanceof Error ? e : new Error(String(e)), { area: 'hf_receipt_view', receipt_id: id }); return 'failed'; };
  try {
    tab.document.title = 'Loading…';
    const { getActiveTokenWaited } = await import('./clerk');
    const token = await getActiveTokenWaited(6000);
    if (!token) return fail(new Error('receipt_no_token'));
    const res = await fetch(`${API_BASE}/api/hf/wallet/receipts/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!res.ok) return fail(new Error(`receipt_http_${res.status}`));
    const html = await res.text();
    tab.document.open(); tab.document.write(html); tab.document.close();
    return 'ok';
  } catch (e) { return fail(e); }
}
export const RECEIPT_POPUP_MSG = 'Please allow pop-ups for this site to open the receipt.';
export const RECEIPT_FAIL_MSG = 'Could not load the receipt. Please try again.';
