/*
 * extend.ts — thin typed client for the consult "extend time" pair
 * (SPEC-2026-09-01 §4.4):
 *
 *   POST /api/commercial/consult/:id/extend/quote     — price it, idempotent
 *   POST /api/commercial/consult/:id/extend/confirm   — dual-consent + apply
 *
 * `getstream.ts` deliberately does not wrap these (it is scoped to join/
 * prejoin/state per its own header comment), so this island owns the call
 * shapes directly via the shared `request()` helper. Mirrors
 * `worker/src/routes/commercial_stream_sessions.ts` `extensionResponse()`
 * exactly — do not add fields it doesn't return.
 */
import { request, ApiError } from '../../lib/apiClient';

export interface ExtensionQuote {
  ok: true;
  extension_id: string;
  booking_id: string;
  session_id: string;
  extension_minutes: number;
  /** Tokens (₹1 = 1 token). Format with `inr()` before showing — never raw. */
  amount: number;
  currency: string;
  policy_version: string;
  base_ends_at: number;
  extension_ends_at: number;
  rate_per_minute: number;
  state: 'proposed' | 'consented' | 'holding' | 'applied' | 'declined' | 'failed';
  creator_consented: boolean;
  buyer_consented: boolean;
}

export interface ExtensionOutcome {
  /** Present only on the terminal "schedule changed" / "verification failed" paths (202). */
  ok?: boolean;
  state?: 'refunded' | 'review_pending';
  reason?: string;
}

export type ExtensionResult = ExtensionQuote | ExtensionOutcome;

function idFrom(bookingId: string, path: string): string {
  return `/api/commercial/consult/${encodeURIComponent(bookingId)}/${path}`;
}

/** Get (or create — deterministic per current end time + configured minutes) the quote. */
export async function quoteExtension(bookingId: string, jwt: string): Promise<ExtensionQuote | { error: string; status: number }> {
  try {
    return await request<ExtensionQuote>(idFrom(bookingId, 'extend/quote'), { method: 'POST', auth: jwt });
  } catch (e) {
    if (e instanceof ApiError) return { error: e.error, status: e.status };
    throw e;
  }
}

/**
 * Register this caller's consent (or decline). Safe to call again while
 * `state` is still `proposed`/`consented`/`holding` — it is how the UI polls
 * for the other party's consent without double-counting its own.
 */
export async function confirmExtension(
  bookingId: string,
  jwt: string,
  extensionId: string,
  accept: boolean,
): Promise<ExtensionQuote | ExtensionOutcome | { error: string; status: number }> {
  try {
    return await request<ExtensionQuote | ExtensionOutcome>(idFrom(bookingId, 'extend/confirm'), {
      method: 'POST',
      auth: jwt,
      body: { extension_id: extensionId, accept },
    });
  } catch (e) {
    if (e instanceof ApiError) return { error: e.error, status: e.status };
    throw e;
  }
}

export function isQuote(r: ExtensionResult | { error: string; status: number }): r is ExtensionQuote {
  return (r as ExtensionQuote).extension_id !== undefined && (r as ExtensionQuote).state !== undefined;
}
