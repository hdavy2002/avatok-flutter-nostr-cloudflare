import type { BookingPage, HfBooking } from './hfBookingsApi';

/** Local civil days, not fixed 24-hour intervals: DST days can be shorter/longer. */
export function localDayKey(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
export function calendarMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
export function calendarDays(month: Date): Date[] {
  const first = calendarMonth(month);
  const offset = first.getDay();
  const count = Math.ceil((offset + new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()) / 7) * 7;
  return Array.from({ length: count }, (_, index) => new Date(first.getFullYear(), first.getMonth(), 1 - offset + index));
}
export function dayEnd(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
}
/** End is exclusive: an appointment ending at midnight belongs only to the prior day. */
export function bookingsOnDay(rows: HfBooking[], day: Date): HfBooking[] {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = dayEnd(day).getTime();
  return rows.filter(row => Date.parse(row.startUtc) < end && Date.parse(row.endUtc) > start)
    .sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc) || a.id.localeCompare(b.id));
}

/** Keep successful pages on a later failure, but never label them complete. */
export async function collectBookingPages(
  fetchPage: (cursor?: string) => Promise<BookingPage>,
  isCurrent: () => boolean,
): Promise<{ rows: HfBooking[]; error?: unknown }> {
  const rows = new Map<string, HfBooking>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  try {
    do {
      if (!isCurrent()) return { rows: [] };
      const page = await fetchPage(cursor);
      if (!isCurrent()) return { rows: [] };
      for (const row of page.bookings) rows.set(row.id, row);
      cursor = page.nextCursor || undefined;
      pages++;
      if (cursor && pages >= 100) throw new Error('Calendar pagination limit reached');
      if (cursor && seen.has(cursor)) throw new Error('Repeated booking cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { rows: [...rows.values()] };
  } catch (error) { return { rows: [...rows.values()], error }; }
}
