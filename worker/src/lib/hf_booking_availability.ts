export type HfBookingRule = { weekday: number; startMin: number; endMin: number };
export type HfBookingException = {
  date: string;
  startMin: number;
  endMin: number;
  status: "available" | "unavailable";
};
export type HfBookingSchedule = {
  timezone: string;
  version: number;
  durationsMinutes: number[];
  slotIntervalMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  horizonDays: number;
  rules: HfBookingRule[];
  exceptions: HfBookingException[];
};
export type HfBusyInterval = { startAt: number; endAt: number; source?: string };
export type HfBookingSlot = {
  id: string;
  startAt: number;
  endAt: number;
  localDate: string;
  localStartMin: number;
  offsetMinutes: number;
};

/** [HF-BOOKING-UNIFY-1] Every booking is a 10-minute call (HF-REEL-19 / HF-REEL-28). The one length both the app and the web offer. */
export const HF_BOOKING_MINUTES = 10;

const MAX_RULES = 84;
const MAX_EXCEPTIONS = 366;
const MAX_DURATION_MINUTES = 24 * 60;

export function validIanaTimezone(timezone: string): boolean {
  if (typeof timezone !== "string" || timezone.length < 1 || timezone.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

const intIn = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max;

function hasOverlaps<T extends { startMin: number; endMin: number }>(items: T[]): boolean {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  return sorted.some((item, index) => index > 0 && item.startMin < sorted[index - 1].endMin);
}

export function validateHfBookingSchedule(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["schedule must be an object"];
  const s = value as Partial<HfBookingSchedule>;
  const errors: string[] = [];
  if (!validIanaTimezone(String(s.timezone ?? ""))) errors.push("timezone must be a valid IANA timezone");
  if (!intIn(s.version, 0, 2_147_483_646)) errors.push("version must be a non-negative integer");
  if (!intIn(s.slotIntervalMinutes, 5, 240)) errors.push("slotIntervalMinutes must be between 5 and 240");
  if (!intIn(s.bufferMinutes, 0, 240)) errors.push("bufferMinutes must be between 0 and 240");
  if (!intIn(s.minNoticeMinutes, 0, 60 * 24 * 90)) errors.push("minNoticeMinutes is out of range");
  if (!intIn(s.horizonDays, 1, 60)) errors.push("horizonDays must be between 1 and 60");
  if (!Array.isArray(s.durationsMinutes) || s.durationsMinutes.length < 1 || s.durationsMinutes.length > 12 ||
      s.durationsMinutes.some((n) => !intIn(n, 5, MAX_DURATION_MINUTES)) ||
      new Set(s.durationsMinutes).size !== s.durationsMinutes.length) {
    errors.push("durationsMinutes must contain 1 to 12 unique durations between 5 and 1440");
  }
  if (!Array.isArray(s.rules) || s.rules.length > MAX_RULES) {
    errors.push("rules must contain at most 84 windows");
  } else {
    const byDay = new Map<number, HfBookingRule[]>();
    for (const r of s.rules) {
      if (!r || !intIn(r.weekday, 0, 6) || !intIn(r.startMin, 0, 1439) ||
          !intIn(r.endMin, 1, 1440) || r.endMin <= r.startMin) {
        errors.push("each rule needs weekday 0-6 and a same-day window with endMin after startMin");
        continue;
      }
      const dayRules = byDay.get(r.weekday) ?? [];
      dayRules.push(r);
      byDay.set(r.weekday, dayRules);
    }
    for (const rules of byDay.values()) if (hasOverlaps(rules)) errors.push("weekly windows may not overlap");
  }
  if (!Array.isArray(s.exceptions) || s.exceptions.length > MAX_EXCEPTIONS) {
    errors.push("exceptions must contain at most 366 windows");
  } else {
    const byDate = new Map<string, HfBookingException[]>();
    for (const e of s.exceptions) {
      if (!e || !isCalendarDate(e.date) || !intIn(e.startMin, 0, 1439) ||
          !intIn(e.endMin, 1, 1440) || e.endMin <= e.startMin ||
          (e.status !== "available" && e.status !== "unavailable")) {
        errors.push("each exception needs a real date, valid same-day window and status");
        continue;
      }
      const dateRows = byDate.get(e.date) ?? [];
      dateRows.push(e);
      byDate.set(e.date, dateRows);
    }
    for (const rows of byDate.values()) if (hasOverlaps(rows)) errors.push("exception windows for a date may not overlap");
  }
  return [...new Set(errors)];
}

export function utcOffsetMinutesAt(utcMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  const localAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((localAsUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

export function localDateAndMinute(utcMs: number, timezone: string): { date: string; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(utcMs));
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** Returns all UTC instants matching a local wall time. Empty means a DST gap;
 * two entries mean a repeated fall-back time. */
export function localWallTimeCandidates(date: string, minute: number, timezone: string): number[] {
  if (!isCalendarDate(date) || !intIn(minute, 0, 1440) || !validIanaTimezone(timezone)) return [];
  const targetDate = minute === 1440 ? addDateDays(date, 1) : date;
  const targetMinute = minute === 1440 ? 0 : minute;
  const [year, month, day] = targetDate.split("-").map(Number);
  const wallUtc = Date.UTC(year, month - 1, day, Math.floor(targetMinute / 60), targetMinute % 60);
  const offsets = new Set<number>();
  // Sample both sides of nearby transitions. Candidate round-tripping below
  // filters out offsets that do not apply to this exact local wall time.
  for (let delta = -48; delta <= 48; delta += 3) {
    offsets.add(utcOffsetMinutesAt(wallUtc + delta * 3_600_000, timezone));
  }
  const matches: number[] = [];
  for (const offset of offsets) {
    const utc = wallUtc - offset * 60_000;
    const local = localDateAndMinute(utc, timezone);
    if (local.date === targetDate && local.minute === targetMinute) matches.push(utc);
  }
  return [...new Set(matches)].sort((a, b) => a - b);
}

export function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Buffers apply on both sides; touching half-open intervals remain free at 0 buffer. */
export function conflictsWithBusy(
  startAt: number,
  endAt: number,
  busy: HfBusyInterval[],
  bufferMinutes: number,
): boolean {
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt ||
      !intIn(bufferMinutes, 0, 24 * 60)) return true;
  const pad = bufferMinutes * 60_000;
  return busy.some((x) => !Number.isFinite(x.startAt) || !Number.isFinite(x.endAt) ||
    x.endAt <= x.startAt || intervalsOverlap(startAt - pad, endAt + pad, x.startAt, x.endAt));
}

function mergeWindows(windows: Array<{ startMin: number; endMin: number }>) {
  const sorted = windows.filter((w) => w.endMin > w.startMin).sort((a, b) => a.startMin - b.startMin);
  const out: Array<{ startMin: number; endMin: number }> = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.startMin <= last.endMin) last.endMin = Math.max(last.endMin, w.endMin);
    else out.push({ ...w });
  }
  return out;
}

function dateWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDateDays(date: string, count: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + count));
  return `${dt.getUTCFullYear().toString().padStart(4, "0")}-${(dt.getUTCMonth() + 1).toString().padStart(2, "0")}-${dt.getUTCDate().toString().padStart(2, "0")}`;
}

function windowsForDate(schedule: HfBookingSchedule, date: string) {
  const windows = schedule.rules.filter((r) => r.weekday === dateWeekday(date))
    .map((r) => ({ startMin: r.startMin, endMin: r.endMin }));
  const exceptions = schedule.exceptions.filter((e) => e.date === date);
  const available = mergeWindows([
    ...windows,
    ...exceptions.filter((e) => e.status === "available").map((e) => ({ startMin: e.startMin, endMin: e.endMin })),
  ]);
  for (const closure of exceptions.filter((e) => e.status === "unavailable")) {
    const next: typeof available = [];
    for (const w of available) {
      if (closure.endMin <= w.startMin || closure.startMin >= w.endMin) next.push(w);
      else {
        if (w.startMin < closure.startMin) next.push({ startMin: w.startMin, endMin: closure.startMin });
        if (w.endMin > closure.endMin) next.push({ startMin: closure.endMin, endMin: w.endMin });
      }
    }
    available.splice(0, available.length, ...next);
  }
  return available;
}

export function slotsForDate(
  schedule: HfBookingSchedule,
  date: string,
  durationMinutes: number,
  busy: HfBusyInterval[] = [],
  now = Date.now(),
): HfBookingSlot[] {
  if (validateHfBookingSchedule(schedule).length || !isCalendarDate(date) ||
      !intIn(durationMinutes, 5, MAX_DURATION_MINUTES)) return [];
  const today = localDateAndMinute(now, schedule.timezone).date;
  const lastDate = addDateDays(today, schedule.horizonDays - 1);
  const absoluteLimit = now + schedule.horizonDays * 86_400_000;
  if (date < today || date > lastDate) return [];
  const earliest = now + schedule.minNoticeMinutes * 60_000;
  const out: HfBookingSlot[] = [];
  for (const window of windowsForDate(schedule, date)) {
    const windowEnds = localWallTimeCandidates(date, window.endMin, schedule.timezone);
    for (let minute = window.startMin; minute + durationMinutes <= window.endMin; minute += schedule.slotIntervalMinutes) {
      const starts = localWallTimeCandidates(date, minute, schedule.timezone);
      for (const startAt of starts) {
        const endAt = startAt + durationMinutes * 60_000;
        const nextWindowEnd = windowEnds.filter((windowEnd) => windowEnd > startAt).sort((a, b) => a - b)[0];
        if (!nextWindowEnd || endAt > nextWindowEnd || startAt < earliest || endAt > absoluteLimit ||
            conflictsWithBusy(startAt, endAt, busy, schedule.bufferMinutes)) continue;
        const offsetMinutes = utcOffsetMinutesAt(startAt, schedule.timezone);
        out.push({
          id: `${startAt}`,
          startAt,
          endAt,
          localDate: date,
          localStartMin: minute,
          offsetMinutes,
        });
      }
    }
  }
  return out.sort((a, b) => a.startAt - b.startAt);
}

export function isBookingDateRangeWithinHorizon(
  schedule: HfBookingSchedule,
  from: string,
  to: string,
  now = Date.now(),
): boolean {
  if (validateHfBookingSchedule(schedule).length || !isCalendarDate(from) || !isCalendarDate(to) || to < from) return false;
  const today = localDateAndMinute(now, schedule.timezone).date;
  const lastDate = addDateDays(today, schedule.horizonDays - 1);
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
  return days >= 1 && days <= schedule.horizonDays && days <= 60 && from >= today && to <= lastDate;
}

export function slotsForRange(
  schedule: HfBookingSchedule,
  from: string,
  to: string,
  durationMinutes: number,
  busy: HfBusyInterval[] = [],
  now = Date.now(),
): HfBookingSlot[] {
  if (!isBookingDateRangeWithinHorizon(schedule, from, to, now) ||
      !schedule.durationsMinutes.includes(durationMinutes)) return [];
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
  const slots: HfBookingSlot[] = [];
  for (let i = 0; i < days; i++) slots.push(...slotsForDate(schedule, addDateDays(from, i), durationMinutes, busy, now));
  return slots;
}

export function offsetLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `UTC${sign}${Math.floor(absolute / 60).toString().padStart(2, "0")}:${(absolute % 60).toString().padStart(2, "0")}`;
}
