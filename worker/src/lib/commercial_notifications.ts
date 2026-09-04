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

export async function notifyCommercialUsers(
  env: Env,
  uids: string[],
  event: Event,
): Promise<{ attempted: number; failed: number }> {
  const unique = [...new Set(uids.filter(Boolean))].slice(0, 200);
  // Stable notification ids make retries safe. Report partial failure so a
  // durable caller can leave its delivery marker pending and retry.
  const results = await Promise.allSettled(
    unique.map((uid) => notifyCommercialUser(env, uid, event)),
  );
  return {
    attempted: unique.length,
    failed: results.filter((result) => result.status === "rejected").length,
  };
}

export async function notifyLiveAudience(
  env: Env,
  event: Event,
  creatorId: string,
): Promise<{ attempted: number; failed: number }> {
  if (!event.listingId) return { attempted: 0, failed: 0 };
  const rows = await metaDb(env).prepare(
    `SELECT DISTINCT account_id FROM commercial_entitlements
      WHERE listing_id=?1 AND kind='live_event'
        AND role IN ('viewer','buyer')
        AND state IN ('reserved','held','active','consumed')
      LIMIT 200`,
  ).bind(event.listingId).all<{ account_id: string }>();
  return notifyCommercialUsers(
    env,
    [creatorId, ...(rows.results ?? []).map((r) => r.account_id)],
    event,
  );
}
