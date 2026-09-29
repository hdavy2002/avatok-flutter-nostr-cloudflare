/* [SAATHUM-UPI-3LAYER 2026-09-29] Small formatting helpers shared by the
 * approved payment screens (PayStep / DoneStep). */
import { ORG } from '../../lib/org';

/** Only real contact details: support@saathum.com from lib/org.ts (also the
 * address the /contact page delivers to). No WhatsApp number exists in the
 * codebase, so none is shown. */
export const SUPPORT_EMAIL: string = ORG.email;

/** ₹199.37 — always two decimals, exactly as the mock shows amounts. */
export function rupees(n: number): string {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function whenLabel(startsAt: number | null | undefined): string {
  if (startsAt == null) return '';
  const ms = startsAt < 1e12 ? startsAt * 1000 : startsAt;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const date = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  const time = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).format(d).toUpperCase();
  return `${date} · ${time} IST`;
}

/** Short, quotable booking reference derived from the checkout id. */
export function bookingRef(checkoutId: string): string {
  return `SAA-${checkoutId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export function payableRupees(c: { payment: { amount_rupees: number }; pay_amount_paise?: number }): number {
  return typeof c.pay_amount_paise === 'number' ? c.pay_amount_paise / 100 : c.payment.amount_rupees;
}
