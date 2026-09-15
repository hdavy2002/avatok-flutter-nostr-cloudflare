import { request } from './apiClient';

/** Shared schedule contract for the web creator calendar and native clients. */
export type ScheduleMode = 'shared' | 'custom' | 'exclusive';
export type ExceptionStatus = 'available' | 'unavailable' | 'reserved';

export interface AvailabilityRule {
  weekday: number;
  start_min: number;
  end_min: number;
}

export interface AvailabilityException {
  id: string;
  date: string;
  start_min: number;
  end_min: number;
  status: ExceptionStatus;
  listing_id?: string;
}

export interface CreatorSchedule {
  listing_id: string | null;
  timezone: string;
  mode: ScheduleMode;
  duration_min: number;
  slot_interval_min: number;
  buffer_min: number;
  min_notice_min: number;
  max_per_day: number;
  horizon_days: number;
  version: number;
  rules: AvailabilityRule[];
  exceptions: AvailabilityException[];
}

export interface ScheduleResponse {
  schedule: CreatorSchedule;
}

export interface AvailabilityDay {
  date: string;
  available_count: number;
}

export interface AvailabilitySlot {
  id: string;
  start_at: number;
  end_at: number;
  available: boolean;
  reason?: string;
}

export interface ListingAvailabilityResponse {
  timezone: string;
  version: number;
  generated_at: number;
  days: AvailabilityDay[];
  slots: AvailabilitySlot[];
}

export interface ConflictItem {
  title: string;
  start_at: number;
  end_at: number;
}

export interface ConflictAlternative {
  start_at: number;
  end_at: number;
}

export interface ConflictPreviewResponse {
  ok: boolean;
  conflicts: ConflictItem[];
  alternatives: ConflictAlternative[];
}

export interface CalendarBlock {
  id: string;
  source_app: string;
  source_ref?: string;
  starts_at: number;
  ends_at: number;
  title?: string;
  status?: string;
  listing_id?: string;
  /* [CAL-AUDIT-2026-09-15] Additive fields on GET /api/calendar/blocks once a
   * newer backend is deployed: they are present only when the block is safely
   * owner-resolved, so every consumer must keep working without them. Without
   * `booking_id` the block is shown as its own card — calendarCore
   * .dayItemsForRange NEVER guesses ownership from an identical interval. */
  booking_id?: string | null;
  booking_kind?: string | null;
  booking_status?: string | null;
  /** creator | customer | null — stated by the server, never guessed from a
   *  title or from an overlapping interval (see calendarCore.bookingRoleOf). */
  booking_role?: string | null;
}

export interface CalendarEvent {
  booking_id?: string;
  slot_id?: string;
  role?: string;
  /** [CAL-AUDIT-2026-09-15] Additive on a newer backend: creator | customer |
   *  null for a booking the server could resolve to this account. Absent on an
   *  older one, where `role` (host/attendee) is normalised instead. */
  booking_role?: string | null;
  title?: string;
  start_at: number;
  end_at: number;
  price_coins?: number;
  status?: string;
  source?: string;
  listing_id?: string;
}

export interface GoogleCalendarStatus {
  connected: boolean;
  connected_at?: number | null;
  last_sync_at?: number | null;
  error?: string | null;
  last_error?: string | null;
  destination_calendar_id?: string | null;
  calendars?: GoogleCalendar[];
  /* [CAL-AUDIT-2026-09-15] Additive readiness fields. An older deployed Worker
   * omits all three, which is why they are optional and why the UI shows
   * "not verified" instead of "Ready" when they are absent: readiness must be
   * derived from the OLDEST SELECTED calendar's success, never the newest. */
  ready?: boolean;
  reason?: string | null;
  last_success_at?: number | null;
}

export interface GoogleCalendar {
  id: string;
  summary: string;
  timezone: string;
  access_role?: string | null;
  primary: boolean;
  selected: boolean;
  destination: boolean;
  last_sync_at?: number | null;
  last_success_at?: number | null;
  last_error?: string | null;
}

export function getCreatorSchedule(token: string, listingId?: string | null, signal?: AbortSignal): Promise<ScheduleResponse> {
  return request<ScheduleResponse>('/api/calendar/schedule', {
    auth: token,
    query: listingId ? { listing_id: listingId } : undefined,
    signal,
  });
}

export function saveCreatorSchedule(token: string, schedule: CreatorSchedule, signal?: AbortSignal): Promise<ScheduleResponse> {
  return request<ScheduleResponse>('/api/calendar/schedule', {
    method: 'PUT',
    auth: token,
    query: schedule.listing_id ? { listing_id: schedule.listing_id } : undefined,
    body: { schedule },
    signal,
  });
}

export function getListingAvailability(
  listingId: string,
  from: string,
  to: string,
  timezone: string,
  token?: string | null,
  signal?: AbortSignal,
): Promise<ListingAvailabilityResponse> {
  return request<ListingAvailabilityResponse>(`/api/listings/${encodeURIComponent(listingId)}/availability`, {
    auth: token,
    query: { from, to, timezone },
    signal,
  });
}

export function previewCalendarConflicts(
  token: string,
  body: { listing_id?: string | null; start_at: number; end_at: number; timezone?: string },
  signal?: AbortSignal,
): Promise<ConflictPreviewResponse> {
  return request<ConflictPreviewResponse>('/api/calendar/conflicts/preview', { method: 'POST', auth: token, body, signal });
}

export function getCalendarBlocks(token: string, from: number, to: number, signal?: AbortSignal): Promise<{ blocks: CalendarBlock[] }> {
  return request<{ blocks: CalendarBlock[] }>('/api/calendar/blocks', { auth: token, query: { from, to }, signal });
}

export function getCalendarEvents(token: string, signal?: AbortSignal): Promise<{ events: CalendarEvent[] }> {
  return request<{ events: CalendarEvent[] }>('/api/calendar/events', { auth: token, signal });
}

export function getGoogleCalendarStatus(token: string, signal?: AbortSignal): Promise<GoogleCalendarStatus> {
  return request<GoogleCalendarStatus>('/api/calendar/gcal/status', { auth: token, signal });
}

/** POST /api/calendar/gcal/sync — import busy times NOW (bounded + rate-limited
 *  server-side) and return the same status shape as the GET. Distinct from
 *  GET /api/calendar/gcal/calendars, which only refreshes the CALENDAR LIST.
 *  A backend that predates this route answers 404/405; callers must say so
 *  plainly instead of reporting a healthy sync. */
export function syncGoogleCalendarNow(token: string, signal?: AbortSignal): Promise<GoogleCalendarStatus> {
  return request<GoogleCalendarStatus>('/api/calendar/gcal/sync', { method: 'POST', auth: token, signal });
}

export function getGoogleCalendarConnectUrl(token: string, signal?: AbortSignal): Promise<{ url: string }> {
  return request<{ url: string }>('/api/calendar/gcal/connect', { auth: token, signal });
}

export function getGoogleCalendars(token: string, signal?: AbortSignal): Promise<{ calendars: GoogleCalendar[]; destination_calendar_id?: string | null }> {
  return request<{ calendars: GoogleCalendar[]; destination_calendar_id?: string | null }>('/api/calendar/gcal/calendars', { auth: token, signal });
}

export function saveGoogleCalendarSelection(
  token: string,
  body: { read_calendar_ids: string[]; destination_calendar_id: string },
  signal?: AbortSignal,
): Promise<{ calendars: GoogleCalendar[]; destination_calendar_id: string }> {
  return request<{ calendars: GoogleCalendar[]; destination_calendar_id: string }>('/api/calendar/gcal/calendars', { method: 'PUT', auth: token, body, signal });
}

export function disconnectGoogleCalendar(token: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/calendar/gcal', { method: 'DELETE', auth: token, signal });
}

export function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseDateKey(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addCalendarDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

export function startOfCalendarWeek(date: Date): Date {
  return addCalendarDays(date, -date.getDay());
}

export function daysInCalendarMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

/** [CAL-AUDIT-2026-09-15 · all-day round-trip] Minute 1440 is the END of the
 *  day and must come back as "24:00" — the old `% 24` turned it into "00:00",
 *  which read back as minute 0 and made a whole-day block unsavable on web
 *  while the native app stored 0..1440. `timeToMinutes` already maps "24:00"
 *  back to 1440, so the pair now round-trips. Use `isAllDayInterval` /
 *  `intervalLabel` (lib/calendarCore) for display, and the editor's explicit
 *  "All day" control instead of relying on a browser time input to accept it. */
export function minutesToTime(value: number): string {
  const normalized = Math.max(0, Math.min(1440, Math.round(value)));
  if (normalized === 1440) return '24:00';
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

export function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return Math.max(0, Math.min(1440, (hours || 0) * 60 + (minutes || 0)));
}

/** Convert a local wall time in an IANA zone to its UTC epoch. */
export function epochForDateTime(dateKey: string, time: string, timezone = 'UTC'): number {
  const [year,month,day]=dateKey.split('-').map(Number), [hours,minutes]=time.split(':').map(Number);
  const wall=Date.UTC(year,month-1,day,hours,minutes);
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  const asWall=(epoch:number)=>{
    const parts:Record<string,number>={};
    formatter.formatToParts(new Date(epoch)).forEach(p=>{if(p.type!=='literal')parts[p.type]=Number(p.value);});
    return Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute);
  };
  let epoch=wall;
  for(let i=0;i<3;i++) epoch+=wall-asWall(epoch);
  if(asWall(epoch)!==wall) throw new Error('This time does not exist because of a daylight-saving clock change. Choose another time.');
  return epoch;
}
