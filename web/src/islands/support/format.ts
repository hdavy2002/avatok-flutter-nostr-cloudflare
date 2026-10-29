// [HF-SUPPORT-DESK] Small formatting helpers (dates, SLA text, initials, sizes). Pure, no DOM.
import type { SlaInfo } from './types';

/** Accepts epoch ms, epoch seconds or an ISO string. */
export function toMs(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  const n = Number(v);
  if (Number.isFinite(n) && /^\d+$/.test(v)) return n < 1e11 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const DAY = 86_400_000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function clock(d: Date): string {
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

/** "4 min", "2 h ago", "Yesterday", "12 Oct". Used in lists. */
export function ago(v: number | string | null | undefined, now = Date.now()): string {
  const t = toMs(v);
  if (t == null) return '';
  const diff = now - t;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min`;
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)} h ago`;
  const d = new Date(t);
  const today = new Date(now);
  const y = new Date(now - DAY);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if (d.getFullYear() === today.getFullYear()) return `${d.getDate()} ${MON[d.getMonth()]}`;
  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;
}

/** Admin list: shorter ("4 min", "1 h", "Yesterday"). */
export function agoShort(v: number | string | null | undefined, now = Date.now()): string {
  const t = toMs(v);
  if (t == null) return '';
  const diff = now - t;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min`;
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)} h`;
  return ago(v, now);
}

/** "Mon 27 Oct, 6:42 pm" */
export function fullDate(v: number | string | null | undefined): string {
  const t = toMs(v);
  if (t == null) return '';
  const d = new Date(t);
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}, ${clock(d)}`;
}
/** "9:30 am" */
export function timeOnly(v: number | string | null | undefined): string {
  const t = toMs(v);
  return t == null ? '' : clock(new Date(t));
}
/** "Sep 2026" */
export function monthYear(v: number | string | null | undefined): string {
  const t = toMs(v);
  if (t == null) return '';
  const d = new Date(t);
  return `${MON[d.getMonth()]} ${d.getFullYear()}`;
}

/** SLA text shown in the admin list: "1h 12m left", "20 h left", "1 day left", "Overdue 2 h". */
export function slaText(sla: SlaInfo | null | undefined, now = Date.now()): { text: string; state: 'ok' | 'amber' | 'red' } {
  if (!sla) return { text: '', state: 'ok' };
  const due = toMs(sla.dueAt);
  if (due == null) return { text: '', state: sla.state ?? 'ok' };
  const diff = due - now;
  const abs = Math.abs(diff);
  const mins = Math.floor(abs / 60_000);
  const hours = Math.floor(abs / 3_600_000);
  const days = Math.round(abs / DAY);
  if (diff < 0) {
    const late = abs < 3_600_000 ? `${Math.max(1, mins)} m` : abs < DAY * 1.5 ? `${hours} h` : plural(days, 'day');
    return { text: `Overdue ${late}`, state: 'red' };
  }
  let left: string;
  if (abs < 3_600_000) left = `${Math.max(1, mins)}m`;
  else if (abs < 2 * 3_600_000) left = `${hours}h ${mins - hours * 60}m`;
  else if (abs < DAY * 1.5) left = `${hours} h`;
  else left = plural(days, 'day');
  const state = sla.state && sla.state !== 'ok' ? sla.state : diff < 3_600_000 * 2 ? 'amber' : 'ok';
  return { text: `${left} left`, state };
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? '').replace(/<.*?>/g, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const a = parts[0][0] ?? '';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase();
}

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function rupees(n: number | null | undefined): string {
  if (n == null) return '–';
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Escape text for use inside HTML. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain text -> <p> paragraphs with <br> for single newlines. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px 0">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}
