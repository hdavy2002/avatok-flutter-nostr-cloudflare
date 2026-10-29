import { request, ApiError } from './apiClient';
import { getActiveTokenWaited } from './clerk';
import { capture } from './analytics';

export interface WindowRule { weekday: number; startMin: number; endMin: number }
export interface DateException { date: string; startMin: number; endMin: number; status: 'available' | 'unavailable' }
export interface AvailabilitySchedule {
  timezone: string; version: number; durationsMinutes: number[]; slotIntervalMinutes: number;
  bufferMinutes: number; minNoticeMinutes: number; horizonDays: number;
  rules: WindowRule[]; exceptions: DateException[];
}
export interface AvailabilitySlot { startUtc: string; endUtc: string; hostLocalLabel: string; offsetLabel: string }
export interface BookingQuote {
  id: string; expiresAt: string; startUtc: string; endUtc: string; durationMinutes: number;
  reservedPaise: number; priceRupees: string;
  /** [HF-CALL-MODES-E1] BookingLengthFields (worker/src/lib/hf_call_contracts.ts): what is held now (cost of the first holdMinutes). Absent while hfBookingLengthsEnabled is off. */
  holdPaise?: number; holdMinutes?: number; durationsMinutes?: number[];
}
export interface HfBooking {
  id: string; status: string; hostUid: string; customerUid: string; startUtc: string; endUtc: string;
  hostTimezone: string; reservedPaise: number; expectedHostNetPaise?: number; callId?: string | null;
  hostName?: string; hostSlug?: string | null; customerHandle?: string; customerPhotoUrl?: string | null; durationMinutes?: number;
}
export interface BookingSummary {
  upcomingCount: number; expectedHostNetPaise: number; nextBooking: HfBooking | null;
  /** [HF-BOOKING-E2E-1] Requests waiting for the influencer's yes, and how many different days carry a booking or a request. */
  waitingCount?: number; bookedDays?: number;
}
export interface BookingPage { bookings: HfBooking[]; nextCursor?: string | null }
export type BookingRole = 'host' | 'customer';
export interface LegacyHoursPreview { days: unknown; from: unknown; to: unknown }
export interface LegacyAvailabilityPreview { requiresHostTimezoneConfirmation: boolean; hours: LegacyHoursPreview }

let bookingsConfig: Promise<boolean> | null = null;
/** Public booking kill switch. Fail closed while config is unavailable. */
export function bookingsEnabled(): Promise<boolean> {
  if (!bookingsConfig) bookingsConfig = request<{ hfBookingsEnabled?: boolean }>('/api/config', { timeoutMs: 8000 })
    .then(config => config?.hfBookingsEnabled === true).catch(() => false);
  return bookingsConfig;
}

export function normalizeAvailabilitySchedule(schedule: AvailabilitySchedule): AvailabilitySchedule {
  const rules = schedule.rules.flatMap(rule => rule.endMin > rule.startMin
    ? [rule]
    : rule.endMin < rule.startMin
      ? [{ ...rule, endMin: 1440 }, ...(rule.endMin > 0 ? [{ ...rule, weekday: (rule.weekday + 1) % 7, startMin: 0 }] : [])]
      : []);
  const exceptions = schedule.exceptions.flatMap(item => {
    if (item.endMin > item.startMin) return [item];
    if (item.endMin === item.startMin) return [];
    const nextDate = new Date(item.date + 'T12:00:00');
    nextDate.setDate(nextDate.getDate() + 1);
    const date = [nextDate.getFullYear(), String(nextDate.getMonth() + 1).padStart(2, '0'), String(nextDate.getDate()).padStart(2, '0')].join('-');
    return [{ ...item, endMin: 1440 }, ...(item.endMin > 0 ? [{ ...item, date, startMin: 0 }] : [])];
  });
  return { ...schedule, rules, exceptions };
}
export const scheduleUpdateBody = (schedule: AvailabilitySchedule, expectedVersion: number, confirmLegacyPreview = false) => ({
  schedule, expectedVersion, ...(confirmLegacyPreview ? { confirmLegacyPreview: true } : {}),
});
export function legacyHoursToRules(hours: LegacyHoursPreview): WindowRule[] {
  const parseMinute = (value: unknown) => {
    if (typeof value !== 'string') return null;
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const startMin = parseMinute(hours.from); const endMin = parseMinute(hours.to);
  if (startMin == null || endMin == null || startMin === endMin || !Array.isArray(hours.days)) return [];
  const days = [...new Set(hours.days)].filter((day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6);
  const rules = days.flatMap(day => {
    const weekday = (day + 1) % 7; // legacy values are Monday-first; schedule values are Sunday-first
    if (endMin > startMin) return [{ weekday, startMin, endMin }];
    return [
      { weekday, startMin, endMin: 1440 },
      ...(endMin > 0 ? [{ weekday: (weekday + 1) % 7, startMin: 0, endMin }] : []),
    ];
  });
  const seen = new Set<string>();
  return rules.filter(rule => {
    const signature = `${rule.weekday}:${rule.startMin}:${rule.endMin}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}
export const bookingConfirmationBody = (quoteId: string) => ({ quoteId, policyAccepted: true });
export const bookingIdempotencyHeaders = (key: string) => ({ 'Idempotency-Key': key });
type Envelope<T, K extends string> = Record<K, T>;
const value = <T, K extends string>(raw: Envelope<T, K>, key: K): T => raw[key];

async function auth(): Promise<string> {
  const token = await getActiveTokenWaited(6000);
  if (!token) throw new ApiError(401, 'no_session');
  return token;
}
const telemetry = (event: string, props: Record<string, string | number | boolean | null | undefined>) =>
  capture(event, { feature: 'hf_booking', ...props });

export async function getHostSchedule(): Promise<{ schedule: AvailabilitySchedule; legacyPreview?: LegacyAvailabilityPreview }> {
  const data = await request<Envelope<AvailabilitySchedule, 'schedule'> & { legacyPreview?: LegacyAvailabilityPreview }>('/api/hosts/me/availability', { auth: await auth() });
  return { schedule: value(data, 'schedule'), legacyPreview: data.legacyPreview };
}
export async function saveHostSchedule(schedule: AvailabilitySchedule, expectedVersion: number, confirmLegacyPreview = false): Promise<AvailabilitySchedule> {
  try {
    const data = await request<Envelope<AvailabilitySchedule, 'schedule'>>('/api/hosts/me/availability', {
      method: 'PUT', auth: await auth(), body: scheduleUpdateBody(schedule, expectedVersion, confirmLegacyPreview),
    });
    return value(data, 'schedule');
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) telemetry('hf_booking_schedule_conflict', { expected_version: expectedVersion });
    throw error;
  }
}
export async function getPublicSlotsInfo(slug: string, from: string, to: string, durationMinutes: number): Promise<{ slots: AvailabilitySlot[]; durationsMinutes: number[] | null; needsApproval: boolean }> {
  const data = await request<{ slots: AvailabilitySlot[]; durationsMinutes?: number[]; approvalMode?: string }>(
    '/api/hf/hosts/' + encodeURIComponent(slug) + '/availability',
    { query: { from, to, durationMinutes } },
  );
  return { slots: data.slots, durationsMinutes: Array.isArray(data.durationsMinutes) ? data.durationsMinutes : null, needsApproval: data.approvalMode === 'manual' };
}
export async function getPublicSlots(slug: string, from: string, to: string, durationMinutes: number): Promise<AvailabilitySlot[]> {
  return (await getPublicSlotsInfo(slug, from, to, durationMinutes)).slots;
}
/** The lengths an influencer offers, from the server's "invalid_duration" answer; null when the error is something else. */
export function offeredDurations(error: unknown): number[] | null {
  if (!(error instanceof ApiError) || error.error !== 'invalid_duration') return null;
  const body = (error.body && typeof error.body === 'object' ? error.body : {}) as { durationsMinutes?: unknown };
  const list = Array.isArray(body.durationsMinutes) ? body.durationsMinutes.filter((n): n is number => typeof n === 'number' && n > 0) : [];
  return list.length ? list : null;
}
export async function acceptBooking(id: string): Promise<void> {
  await request('/api/hf/bookings/' + encodeURIComponent(id) + '/accept', { method: 'POST', auth: await auth(), body: {} });
}
export async function declineBooking(id: string): Promise<void> {
  await request('/api/hf/bookings/' + encodeURIComponent(id) + '/decline', { method: 'POST', auth: await auth(), body: {} });
}
export async function createQuote(hostSlug: string, startUtc: string, durationMinutes: number): Promise<BookingQuote> {
  telemetry('hf_booking_quote_requested', { duration_minutes: durationMinutes });
  const data = await request<Envelope<BookingQuote, 'quote'>>('/api/hf/bookings/quote', {
    method: 'POST', auth: await auth(), body: { hostSlug, startUtc, durationMinutes },
  });
  const quote = value(data, 'quote');
  telemetry('hf_booking_quote_received', { quote_id: quote.id, duration_minutes: quote.durationMinutes, reserved_paise: quote.reservedPaise });
  return quote;
}
export async function confirmBooking(quoteId: string, idempotencyKey: string): Promise<HfBooking> {
  try {
    const data = await request<Envelope<HfBooking, 'booking'>>('/api/hf/bookings', {
      method: 'POST', auth: await auth(), headers: bookingIdempotencyHeaders(idempotencyKey),
      body: bookingConfirmationBody(quoteId),
    });
    const booking = value(data, 'booking');
    telemetry('hf_booking_confirmed', { booking_id: booking.id, call_id: booking.callId ?? null, reserved_paise: booking.reservedPaise });
    return booking;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) telemetry('hf_booking_conflict', { quote_id: quoteId, reason: error.error });
    throw error;
  }
}
/** A calendar pins one token across all pages so an account switch cannot mix results. */
export async function listBookings(role: BookingRole, from?: string, to?: string, cursor?: string, token?: string): Promise<BookingPage> {
  return request<BookingPage>('/api/hf/bookings', { auth: token ?? await auth(), query: { role, from, to, cursor } });
}
export async function getBooking(id: string): Promise<HfBooking> {
  const data = await request<Envelope<HfBooking, 'booking'>>('/api/hf/bookings/' + encodeURIComponent(id), { auth: await auth() });
  return value(data, 'booking');
}
export async function cancelBooking(id: string): Promise<HfBooking> {
  const data = await request<Envelope<HfBooking, 'booking'>>('/api/hf/bookings/' + encodeURIComponent(id) + '/cancel', {
    method: 'POST', auth: await auth(), body: {},
  });
  const booking = value(data, 'booking');
  telemetry('hf_booking_cancelled', { booking_id: booking.id, call_id: booking.callId ?? null });
  return booking;
}
export async function getBookingSummary(): Promise<BookingSummary> {
  const data = await request<Envelope<BookingSummary, 'summary'>>('/api/hosts/me/bookings/summary', { auth: await auth() });
  return value(data, 'summary');
}

export function bookingError(error: unknown): { status: number; code: string; message: string; lane?: 'women' | 'lgbtq' | 'kyc' } {
  if (error instanceof ApiError) {
    const body = (error.body && typeof error.body === 'object' ? error.body : {}) as Record<string, unknown>;
    // [HF-CHANNEL-QA-1] Never show a raw code ("no_session") to a fan.
    const KNOWN: Record<string, string> = {
      host_unavailable: 'This influencer can’t take bookings right now. (You can’t book your own page.)',
      slot_taken: 'Someone just took that time. Please pick another.',
      slot_unavailable: 'That time is no longer free. Please pick another.',
      account_paused: 'Your account is paused while a person checks it, so you can’t book right now.', // [HF-CALL-SAFETY-WEB]
    };
    const friendly = error.status === 401 || /session|unauth/i.test(error.error) ? 'Please sign in to book this time.' : KNOWN[error.error] ?? 'Something went wrong. Please try again.';
    if (error.error === 'lane_required') { // [HF-CREATOR-SPACES-1]
      const lane = body.lane === 'lgbtq' ? 'lgbtq' : 'women';
      return { status: error.status, code: error.error, lane, message: lane === 'lgbtq' ? 'Only verified LGBTQ+ members can call this channel' : 'Only verified women can call this channel' };
    }
    if (error.error === 'video_kyc_required_caller') { // [HF-CREATOR-BADGES-1]
      return { status: error.status, code: error.error, lane: 'kyc', message: 'This creator only takes calls from video-KYC verified customers' };
    }
    return { status: error.status, code: error.error, message: typeof body.message === 'string' ? body.message : friendly };
  }
  return { status: 0, code: 'network', message: 'We could not reach the server. Check your connection and try again.' };
}
export function money(paise: number): string {
  return '₹' + (Math.max(0, paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function dateLabel(utc: string, timezone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(utc));
  } catch { return new Date(utc).toLocaleString(); }
}
