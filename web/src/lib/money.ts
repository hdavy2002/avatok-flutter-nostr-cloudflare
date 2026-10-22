/* [HF-STD-PLAN-1] One money display helper for public rupee amounts held as integer paise.
 * "₹101.69", "₹120.00", "₹1,016.95" (two decimals, Indian grouping); a minus sign goes BEFORE the rupee sign ("-₹22.47"). */
export function formatPaise(paise: number): string {
  const n = Math.round(Number(paise));
  if (!Number.isFinite(n)) return '₹0.00';
  const abs = Math.abs(n);
  const body = (abs / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}₹${body}`;
}

/** [HF-WALLET-HELD-LABEL-1] What was kept back from a top-up. Current purchases record it as GST; purchases made under the older
 * pricing (gp-r1, before GST registration) kept the same 18% as part of the price and record GST 0, so the difference paid - added is shown. */
export function topupKeptLabel(paidPaise: number, gstPaise: number, walletPaise: number): string {
  if (gstPaise > 0) return `− GST (18%) ${formatPaise(consistentGstPaise(paidPaise, gstPaise, walletPaise))}`;
  const kept = Math.max(0, paidPaise - walletPaise);
  if (kept <= 0) return 'Nothing held back';
  const pct = walletPaise > 0 ? Math.round((kept / walletPaise) * 100) : 0;
  return `${pct > 0 ? `${pct}% ` : ''}held back ${formatPaise(kept)}`;
}

/** [HF-FIX-WALLET-RECEIPTS-1] GST to display for a top-up so "paid - GST = added" always adds up. Old rows were stored with GST 0 (or a stale
 * figure) while the wallet credit was paid / 1.18; when all three are known and they disagree, GST is whatever was kept: paid - added. */
export function consistentGstPaise(paidPaise: number, gstPaise: number, walletPaise: number): number {
  if (paidPaise - gstPaise !== walletPaise && paidPaise > walletPaise) return paidPaise - walletPaise;
  return gstPaise;
}
