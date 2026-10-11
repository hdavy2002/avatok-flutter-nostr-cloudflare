/* [HF-STD-PLAN-1] One money display helper for public rupee amounts held as integer paise.
 * "₹101.69", "₹120.00", "₹1,016.95" (two decimals, Indian grouping); a minus sign goes BEFORE the rupee sign ("-₹22.47"). */
export function formatPaise(paise: number): string {
  const n = Math.round(Number(paise));
  if (!Number.isFinite(n)) return '₹0.00';
  const abs = Math.abs(n);
  const body = (abs / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}₹${body}`;
}
