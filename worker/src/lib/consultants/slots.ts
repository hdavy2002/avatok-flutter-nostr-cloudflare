// [AUMFE-CONSULT-FOUNDATION-1] Slot generation — pure. All times are epoch ms; rules are in IST (UTC+05:30).
// A rule = weekday (0=Sun..6=Sat) + "HH:MM" start/end. Exceptions: whole day off, or extra window on a date.

export const IST_OFFSET_MS = 330 * 60 * 1000;
export const MIN_LEAD_MS = 2 * 60 * 60 * 1000;   // a slot must start at least 2 h from now
export const HOLD_MS = 10 * 60 * 1000;           // unpaid hold lasts 10 min
export const JOIN_EARLY_MS = 10 * 60 * 1000;     // Join opens 10 min early
export const GRACE_AFTER_MS = 5 * 60 * 1000;     // call may run 5 min past the slot

export interface AvailabilityRule { weekday: number; start: string; end: string }
export interface AvailabilityException { date: string; off: boolean; start?: string | null; end?: string | null }
export interface Busy { start_ms: number; end_ms: number }

const hm = (s: string): number => { const [h, m] = s.split(":").map(Number); return (h * 60 + (m || 0)) * 60000; };
/** IST midnight (epoch ms) for a YYYY-MM-DD date. */
export function istMidnight(date: string): number { return Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS; }
export function istDate(ms: number): string { return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10); }
export function istWeekday(date: string): number { return new Date(`${date}T00:00:00Z`).getUTCDay(); }
export function istLabel(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS); let h = d.getUTCHours(); const m = d.getUTCMinutes();
  const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}

export function windowsFor(date: string, rules: AvailabilityRule[], exceptions: AvailabilityException[]): [number, number][] {
  const ex = exceptions.filter((e) => e.date === date);
  if (ex.some((e) => e.off)) return [];
  const base = istMidnight(date);
  const out: [number, number][] = rules.filter((r) => r.weekday === istWeekday(date)).map((r) => [base + hm(r.start), base + hm(r.end)]);
  for (const e of ex) if (e.start && e.end) out.push([base + hm(e.start), base + hm(e.end)]);
  return out.sort((a, b) => a[0] - b[0]);
}

export function slotsFor(
  date: string, rules: AvailabilityRule[], exceptions: AvailabilityException[], busy: Busy[],
  slotMinutes: number, bufferMinutes: number, nowMs: number,
): { start_ms: number; label: string }[] {
  const len = slotMinutes * 60000, step = (slotMinutes + bufferMinutes) * 60000;
  const out: { start_ms: number; label: string }[] = [];
  for (const [a, b] of windowsFor(date, rules, exceptions)) {
    for (let s = a; s + len <= b; s += step) {
      if (s < nowMs + MIN_LEAD_MS) continue;
      if (busy.some((x) => s < x.end_ms && s + len > x.start_ms)) continue;
      out.push({ start_ms: s, label: istLabel(s) });
    }
  }
  return out;
}
