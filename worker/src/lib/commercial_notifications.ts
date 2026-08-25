import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { notifyUser } from "../notify";

export type CommercialNotificationType =
  | "commercial_checkout_confirmed"
  | "commercial_session_rescheduled"
  | "commercial_session_cancelled"
  | "commercial_join_window"
  | "commercial_broadcast_started"
  | "commercial_broadcast_ended"
  | "commercial_refund"
  | "commercial_receipt";

type Event = {
  type: CommercialNotificationType;
  eventId: string;
  listingId?: string | null;
  bookingId?: string | null;
  sessionId?: string | null;
  title: string;
  body: string;
};

function stableId(event: Event, uid: string): string {
  return `commercial-notification:${event.type}:${event.eventId}:${uid}`;
}

function data(event: Event): Record<string, string> {
  // Deliberately construct an allowlist. Provider call ids, access tokens and
  // join URLs must never cross the notification boundary.
  return {
    type: event.type,
    ...(event.listingId ? { listing_id: event.listingId } : {}),
    ...(event.bookingId ? { booking_id: event.bookingId } : {}),
    ...(event.sessionId ? { session_id: event.sessionId } : {}),
  };
}

export async function notifyCommercialUser(env: Env, uid: string, event: Event): Promise<void> {
  if (!uid) return;
  await notifyUser(env, uid, {
    type: "commercial",
    title: event.title,
    body: event.body,
    data: data(event),
  }, { id: stableId(event, uid) });
}

export async function notifyCommercialUsers(env: Env, uids: string[], event: Event): Promise<void> {
  const unique = [...new Set(uids.filter(Boolean))].slice(0, 200);
  // The audience is intentionally bounded; commercial events currently have a
  // small audience and each account is authorized before it enters this list.
  await Promise.all(unique.map((uid) => notifyCommercialUser(env, uid, event).catch(() => undefined)));
}

export async function notifyLiveAudience(env: Env, event: Event, creatorId: string): Promise<void> {
  if (!event.listingId) return;
  const rows = await metaDb(env).prepare(
    `SELECT DISTINCT account_id FROM commercial_entitlements
      WHERE listing_id=?1 AND kind='live_event'
        AND role IN ('viewer','buyer')
        AND state IN ('reserved','held','active','consumed')
      LIMIT 200`,
  ).bind(event.listingId).all<{ account_id: string }>();
  await notifyCommercialUsers(env, [creatorId, ...(rows.results ?? []).map((r) => r.account_id)], event);
}
