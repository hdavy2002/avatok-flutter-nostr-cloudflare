// [AUMFE-CONSULT-F1-1 2026-10-02] Pure formatting + calendar helpers for the consultant surfaces (all times IST).
import type { ConsultantCard, Discipline } from '../../lib/consultTypes';

export const rupees = (n: number): string => '₹' + Math.round(n).toLocaleString('en-IN');

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n: number) => String(n).padStart(2, '0');

/** Today's date in IST as YYYY-MM-DD. */
export function istToday(now: number = Date.now()): string {
  const ist = new Date(now + 5.5 * 3600 * 1000);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

export interface YM { y: number; m: number } // m = 1..12
export const ymOf = (date: string): YM => ({ y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)) });
export const ymKey = ({ y, m }: YM): string => `${y}-${pad(m)}`;
export const addMonths = ({ y, m }: YM, n: number): YM => {
  const t = y * 12 + (m - 1) + n;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
};
export const monthTitle = ({ y, m }: YM): string => `${MON_LONG[m - 1]} ${y}`;
export const daysInMonth = ({ y, m }: YM): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** Number of blank cells before the 1st when weeks start on Monday. */
export const leadingBlanks = ({ y, m }: YM): number => (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
export const dateStr = ({ y, m }: YM, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

/** "Tue 6 Oct" for a YYYY-MM-DD date. */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}
export function dayShort(date: string): string {
  return DOW[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

/** "Tue 6 Oct, 10:30 AM" (IST) for an epoch-ms instant. */
export function nextFreeLabel(ms: number): string {
  const ist = new Date(ms + 5.5 * 3600 * 1000);
  const h = ist.getUTCHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${DOW[ist.getUTCDay()]} ${ist.getUTCDate()} ${MON[ist.getUTCMonth()]}, ${h12}:${pad(ist.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}

export const stars = (avg: number | null): string => {
  const n = Math.max(0, Math.min(5, Math.round(avg ?? 0)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
};

const ROLE: Record<Discipline, string> = {
  astrology: 'Vedic astrologer', numerology: 'Numerologist', palmistry: 'Palmist', face_reading: 'Face reader', tarot: 'Tarot reader',
};
export const roleLine = (c: Pick<ConsultantCard, 'disciplines'>): string => c.disciplines.map((d) => ROLE[d]).join(' · ');

export const isDiscipline = (v: string | null | undefined, list: readonly Discipline[]): v is Discipline =>
  !!v && (list as readonly string[]).includes(v);
