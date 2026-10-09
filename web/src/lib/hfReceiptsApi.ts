/* [HF-WALLET-LIMITS-1] Receipts client. Worker: GET /api/hf/wallet/receipts, GET /api/hf/wallet/receipts/:id (printable HTML, bearer-auth so it is
 * fetched and shown in a new tab rather than linked). */
import { API_BASE } from './env';
import { hfCall, type HfResult } from './hfCallsApi';

export interface ReceiptItem { id: string; number: string; kind: 'receipt' | 'tax_invoice'; source: string; amountRupees: number; issuedAt: number }
export interface ReceiptList { ok: boolean; invoicing: boolean; receipts: ReceiptItem[] }
export const fetchReceipts = (): Promise<HfResult<ReceiptList>> => hfCall<ReceiptList>('GET', '/api/hf/wallet/receipts');

/** Opens the printable page in a new tab. The tab is opened first (inside the tap) so pop-up blockers allow it. Returns false if it could not be shown. */
export async function openReceipt(id: string): Promise<boolean> {
  const tab = window.open('', '_blank');
  if (!tab) return false;
  try {
    tab.document.title = 'Loading…';
    const { getActiveTokenWaited } = await import('./clerk');
    const token = await getActiveTokenWaited(6000);
    if (!token) { tab.close(); return false; }
    const res = await fetch(`${API_BASE}/api/hf/wallet/receipts/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!res.ok) { tab.close(); return false; }
    const html = await res.text();
    tab.document.open(); tab.document.write(html); tab.document.close();
    return true;
  } catch { try { tab.close(); } catch { /* ignore */ } return false; }
}
