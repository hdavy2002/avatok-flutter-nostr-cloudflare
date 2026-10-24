/* [HF-CALL-MODES-E1] Web client for the call-modes / queue / chunk-billing / booking-lengths feature.
 * Spec: Specs/SPEC-2026-10-23-HF-CALL-MODES-QUEUE.md. The types below are COPIED from worker/src/lib/hf_call_contracts.ts (keep them in step).
 * Everything here is gated on the public flags from /api/config; with every flag off nothing in this file changes what the site shows. */
import { request } from './apiClient';
import { hfCall, type HfResult, type HostPresence } from './hfCallsApi';

// ── copied contract types (worker/src/lib/hf_call_contracts.ts) ─────────────────────────────────────────────
export type HostMode = 'online' | 'bookings_only' | 'offline';
export const HOST_MODES: readonly HostMode[] = ['online', 'bookings_only', 'offline'];
export type PublicCallState = 'available' | 'on_call' | 'connecting' | 'queue_only' | 'appointments' | 'offline';
export interface HostPresenceResponse {
  ok: true; presence: HostPresence; mode: HostMode; onCall: boolean; queue: { waiting: number; paused: boolean; open: boolean }; bookedCalls?: number;
}
export type QueueStatus = 'waiting' | 'offered' | 'connected' | 'done' | 'left' | 'skipped' | 'expired' | 'closed';
export interface QueueJoinResponse { ok: true; entryId: string; position: number; waiting: number }
export type QueueJoinErrorCode = 'queue_closed' | 'queue_full' | 'already_queued' | 'low_balance' | 'not_verified';
export interface HostQueueView { ok: true; waiting: number; paused: boolean; entries: Array<{ position: number; firstName: string; joinedAt: number }> }
export interface MyQueueResponse {
  ok: true; entry: null | { entryId: string; hostSlug: string; hostName: string; position: number; status: QueueStatus; callId?: string };
}
/** Allowed booking lengths in minutes when hfBookingLengthsEnabled. */
export const HF_BOOKING_LENGTHS = [15, 30, 60, 120, 180, 240, 300] as const;
export const HF_BOOKING_HOLD_MINUTES_DEFAULT = 15;

// ── flags ───────────────────────────────────────────────────────────────────────────────────────────────────
export interface CallModeFlags { modes: boolean; queue: boolean; chunk: boolean; lengths: boolean }
export const NO_FLAGS: CallModeFlags = { modes: false, queue: false, chunk: false, lengths: false };
let flagsP: Promise<CallModeFlags> | null = null;
/** The four public flags from /api/config (one request per page). Any failure = everything off, i.e. today's behaviour. */
export function callModeFlags(): Promise<CallModeFlags> {
  if (!flagsP) {
    flagsP = request<{ hfCallModesEnabled?: boolean; hfCallQueueEnabled?: boolean; hfCallChunkBillingEnabled?: boolean; hfBookingLengthsEnabled?: boolean }>('/api/config', { timeoutMs: 8000 })
      .then(c => ({
        modes: c?.hfCallModesEnabled === true,
        // the queue and the money engine only make sense with the modes in place; they can never show alone
        queue: c?.hfCallModesEnabled === true && c?.hfCallQueueEnabled === true,
        chunk: c?.hfCallChunkBillingEnabled === true,
        lengths: c?.hfBookingLengthsEnabled === true,
      }))
      .catch(() => NO_FLAGS);
  }
  return flagsP;
}

// ── fan side: callState -> buttons (spec 2.1) ───────────────────────────────────────────────────────────────
/** Older servers do not send callState; derive the nearest one from the legacy presence. */
export function deriveCallState(status: HostPresence | undefined, callState?: string | null): PublicCallState {
  if (callState === 'available' || callState === 'on_call' || callState === 'connecting' || callState === 'queue_only' || callState === 'appointments' || callState === 'offline') return callState;
  return status === 'online' ? 'available' : status === 'busy' ? 'on_call' : 'offline';
}
export interface FanButtons {
  /** Short status text for the badge on the profile. */
  badge: string;
  /** Show the real "Call now" button (the existing call flow). */
  callNow: boolean;
  /** Show "Join the queue". */
  queue: boolean;
  /** Show "Book a time". */
  book: boolean;
  /** Show "Notify me". */
  notify: boolean;
}
/** The whole spec 2.1 table. `bookingOn` = hfBookingsEnabled, `queueOn` = hfCallQueueEnabled. With the queue flag off an on-call host falls back to Notify me, as today. */
export function fanButtons(state: PublicCallState, bookingOn: boolean, queueOn: boolean): FanButtons {
  switch (state) {
    case 'available': return { badge: 'Online', callNow: true, queue: false, book: bookingOn, notify: false };
    case 'on_call': return { badge: 'On a call', callNow: false, queue: queueOn, book: bookingOn, notify: !queueOn };
    case 'connecting': return { badge: 'Online', callNow: false, queue: queueOn, book: bookingOn, notify: !queueOn };
    case 'queue_only': return { badge: 'Online', callNow: false, queue: queueOn, book: bookingOn, notify: !queueOn };
    case 'appointments': return { badge: 'Available by appointment', callNow: false, queue: false, book: bookingOn, notify: true };
    default: return { badge: 'Offline', callNow: false, queue: false, book: false, notify: true };
  }
}
/** Why a start was refused, in plain words for the fan. */
export function refusalText(reason: string | undefined, name: string): string | null {
  switch (reason) {
    case 'on_call': return `${name} is on a call right now.`;
    case 'connecting': return `${name} is about to take a call.`;
    case 'queue_only': return `${name} has people waiting, so everyone gets a turn in order.`;
    case 'appointments': return `${name} takes calls by appointment.`;
    case 'offline': return `${name} is offline right now.`;
    default: return null;
  }
}
export const QUEUE_PROMISE = 'We’ll WhatsApp you just before we call. Nothing is charged until you talk.';

// ── queue API (fan) ─────────────────────────────────────────────────────────────────────────────────────────
export const joinQueue = (slug: string): Promise<HfResult<QueueJoinResponse>> => hfCall<QueueJoinResponse>('POST', `/api/hf/hosts/${encodeURIComponent(slug)}/queue`);
export const leaveQueue = (slug: string): Promise<HfResult<{ ok: boolean }>> => hfCall<{ ok: boolean }>('DELETE', `/api/hf/hosts/${encodeURIComponent(slug)}/queue`);
export const myQueue = (): Promise<HfResult<MyQueueResponse>> => hfCall<MyQueueResponse>('GET', '/api/hf/queue/me');
/** Friendly text for a failed join. `link` is where the fan can go next. */
export function queueJoinProblem(code: string, body: Record<string, unknown>, name: string, fallback: string): { text: string; link?: { href: string; label: string } } {
  switch (code) {
    case 'queue_closed': return { text: `${name}’s queue is closed right now. You can book a time instead.` };
    case 'queue_full': return { text: `${name}’s queue is full right now. Please try again a little later, or book a time.` };
    case 'already_queued': {
      const slug = typeof body.hostSlug === 'string' ? body.hostSlug : '';
      return { text: 'You are already waiting in a queue. You can wait for one influencer at a time.', link: slug ? { href: `/h/${encodeURIComponent(slug)}`, label: 'Go to that queue' } : undefined };
    }
    case 'low_balance': {
      const s = typeof body.shortfallPaise === 'number' && body.shortfallPaise > 0 ? `₹${(body.shortfallPaise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '';
      return { text: s ? `Add ${s} more to your wallet to join. Nothing is charged until you talk.` : 'Add a little money to your wallet to join. Nothing is charged until you talk.', link: { href: '/dashboard/wallet#add', label: 'Top up' } };
    }
    case 'lane_required': { // [HF-CREATOR-SPACES-1]
      const ln = body.lane === 'lgbtq' ? 'lgbtq' : 'women';
      return { text: ln === 'lgbtq' ? 'Only verified LGBTQ+ members can call this channel' : 'Only verified women can call this channel', link: { href: `/verify/lane?lane=${ln}&next=${encodeURIComponent(typeof location !== 'undefined' ? location.pathname + location.search : '/')}`, label: 'Verify to call' } };
    }
    case 'video_kyc_required_caller': // [HF-CREATOR-BADGES-1]
      return { text: 'This creator only takes calls from video-KYC verified customers', link: { href: `/verify/lane?lane=kyc&next=${encodeURIComponent(typeof location !== 'undefined' ? location.pathname + location.search : '/')}`, label: 'Verify to call' } };
    case 'not_verified': return { text: 'Please verify your WhatsApp number first. We use it to tell you when it is your turn.', link: { href: '/sign-up?finish=1', label: 'Verify my number' } };
    default: return { text: fallback || 'We could not add you to the queue. Please try again.' };
  }
}

// ── influencer side ─────────────────────────────────────────────────────────────────────────────────────────
export const getMyPresence = (): Promise<HfResult<HostPresenceResponse>> => hfCall<HostPresenceResponse>('GET', '/api/hosts/me/presence');
export const setMyMode = (mode: HostMode): Promise<HfResult<HostPresenceResponse>> => hfCall<HostPresenceResponse>('PUT', '/api/hosts/me/presence', { mode, surface: 'web' }); // surface feeds hf_host_mode_changed
export const getHostQueue = (): Promise<HfResult<HostQueueView>> => hfCall<HostQueueView>('GET', '/api/hosts/me/queue');
export const setQueuePaused = (paused: boolean): Promise<HfResult<HostQueueView>> => hfCall<HostQueueView>('PUT', '/api/hosts/me/queue', { paused });
export const MODE_LABEL: Record<HostMode, string> = { online: 'Online', bookings_only: 'Bookings only', offline: 'Offline' };
export const MODE_HINT: Record<HostMode, string> = {
  online: 'Callers can call you now, join your queue and book times.',
  bookings_only: 'No instant calls. People can still book a time with you.',
  offline: 'No instant calls, queue or new bookings. Calls already booked will still ring.',
};
/** D1: leaving Online/Bookings for Offline while booked calls exist needs a warning first. */
export function offlineWarning(bookedCount: number): string | null {
  if (bookedCount <= 0) return null;
  return `You have ${bookedCount} booked call${bookedCount === 1 ? '' : 's'}. They will still ring.`;
}

// ── booking lengths ─────────────────────────────────────────────────────────────────────────────────────────
/** 15 -> "15 min", 60 -> "1 h", 90 -> "1 h 30 min", 300 -> "5 h". */
export function lengthLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
/** The lengths to offer: what the server says, narrowed to the allowed list; before the server answers, the full list. */
export function offeredLengths(fromServer: number[] | null | undefined): number[] {
  const allowed = new Set<number>(HF_BOOKING_LENGTHS);
  const list = (fromServer ?? []).filter(n => allowed.has(n));
  return list.length ? list : [...HF_BOOKING_LENGTHS];
}
/** "We hold ₹X now (first 15 minutes). The rest is charged 5 minutes at a time while you talk. Unused money comes back." */
export function holdLine(holdText: string, holdMinutes: number): string {
  return `We hold ${holdText} now (first ${holdMinutes} minutes). The rest is charged 5 minutes at a time while you talk. Unused money comes back.`;
}

// ── live call funding (chunk billing) ───────────────────────────────────────────────────────────────────────
/** Whole minutes left until capAt, at least 1 while the call is running, or null when unknown. */
export function minutesLeft(capAt: number | string | null | undefined, now: number): number | null {
  if (capAt == null || capAt === '') return null;
  const ms = typeof capAt === 'string' ? Date.parse(capAt) : capAt < 1e12 ? capAt * 1000 : capAt;
  if (!Number.isFinite(ms)) return null;
  return Math.max(1, Math.ceil((ms - now) / 60_000));
}
