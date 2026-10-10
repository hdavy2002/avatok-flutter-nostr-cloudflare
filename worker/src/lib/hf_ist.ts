// [HF-WALLET-LIMITS-1] IST calendar helpers shared by receipts and reconciliation (HF-PAY-16, HF-PAY-17). [HF-NOLIMITS-1] The spend-limit half of this file was removed.

export const IST_OFFSET_MS = 19_800_000; // UTC+05:30, no DST

const shifted = (ms: number) => new Date(ms + IST_OFFSET_MS); // read with getUTC*

/** Start (00:00 IST) of the IST day containing `ms`, as epoch ms. */
export function istDayStart(ms: number): number {
  const d = shifted(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_OFFSET_MS;
}
export const istNextDayStart = (ms: number): number => istDayStart(ms) + 86_400_000;
/** Start (00:00 IST on the 1st) of the IST calendar month containing `ms`. */
export function istMonthStart(ms: number): number {
  const d = shifted(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST_OFFSET_MS;
}
export function istNextMonthStart(ms: number): number {
  const d = shifted(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - IST_OFFSET_MS;
}
export function istPrevMonthStart(ms: number): number {
  return istMonthStart(istMonthStart(ms) - 1);
}
/** "YYYY-MM-DD" in IST. */
export function istDateStr(ms: number): string {
  const d = shifted(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
/** "YYYY-MM" in IST. */
export const istMonthStr = (ms: number): string => istDateStr(ms).slice(0, 7);
/** "YYYY-MM-DD" (an IST date) -> epoch ms of its 00:00 IST, or null when it is not a real date. */
export function parseIstDate(s: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t - IST_OFFSET_MS;
}
/** Indian financial year (April to March) of the IST moment `ms`: start year, "2026-27" and short "26-27". */
export function financialYear(ms: number): { startYear: number; label: string; short: string } {
  const d = shifted(ms);
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const a = String((y + 1) % 100).padStart(2, "0");
  return { startYear: y, label: `${y}-${a}`, short: `${String(y % 100).padStart(2, "0")}-${a}` };
}
