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
  deeplink?: string | null;
};

function stableId(event: Event, uid: string): string {
  return `commercial-notification:${event.type}:${event.eventId}:${uid}`;
}

function data(event: Event): Record<string, string> {
  // Deliberately construct an allowlist. Provider call ids, access tokens and
  // join URLs must never cross the notification boundary.
  const deeplink = event.deeplink ?? (event.bookingId
    ? `/session/${encodeURIComponent(event.bookingId)}`
    : event.listingId ? `/live/${encodeURIComponent(event.listingId)}` : null);
  return {
    kind: "commercial",
    type: event.type,
    ...(event.listingId ? { listing_id: event.listingId } : {}),
    ...(event.bookingId ? { booking_id: event.bookingId } : {}),
    ...(event.sessionId ? { session_id: event.sessionId } : {}),
    ...(deeplink ? { deeplink } : {}),
  };
}

export async function notifyCommercialUser(env: Env, uid: string, event: Event): Promise<void> {
  if (!uid) return;
  await notifyUser(env, uid, {
    type: "commercial",
    title: event.title,
    body: event.body,
    data: data(event),
  }, { id: stableId(event, uid), requirePush: true });
}

export async function notifyCommercialUsers(
  env: Env,
  uids: string[],
  event: Event,
): Promise<{ attempted: number; failed: number }> {
  const unique = [...new Set(uids.filter(Boolean))];
  // Stable notification ids make retries safe. Report partial failure so a
  // durable caller can leave its delivery marker pending and retry.
  let failed = 0;
  const batchSize = 25;
  for (let i = 0; i < unique.length; i += batchSize) {
    const results = await Promise.allSettled(
      unique.slice(i, i + batchSize).map((uid) => notifyCommercialUser(env, uid, event)),
    );
    failed += results.filter((result) => result.status === "rejected").length;
  }
  return { attempted: unique.length, failed };
}

export async function notifyLiveAudience(
  env: Env,
  event: Event,
  creatorId: string,
): Promise<{ attempted: number; failed: number }> {
  if (!event.listingId) return { attempted: 0, failed: 0 };
  // Keyset pagination reaches the complete audience without OFFSET drift when
  // an entitlement is added while a lifecycle request is running. The stable
  // account cursor plus DISTINCT keeps one recipient from receiving a duplicate
  // row in a page; notification work remains bounded to 25 concurrent sends.
  // This deliberately replaces the old LIMIT 200 audience cap.
  let cursor = "";
  let attempted = 0;
  let failed = 0;
  const pageSize = 100;
  const creatorResult = await notifyCommercialUsers(env, [creatorId], event);
  attempted += creatorResult.attempted;
  failed += creatorResult.failed;
  for (;;) {
    const rows = await metaDb(env).prepare(
      `SELECT DISTINCT account_id FROM commercial_entitlements
        WHERE listing_id=?1 AND kind='live_event'
          AND role IN ('viewer','buyer')
          AND state IN ('reserved','held','active','consumed')
          AND account_id>?2
        ORDER BY account_id ASC LIMIT ?3`,
    ).bind(event.listingId, cursor, pageSize).all<{ account_id: string }>();
    const ids = (rows.results ?? []).map((r) => r.account_id).filter((id) => id && id !== creatorId);
    if (ids.length) {
      const result = await notifyCommercialUsers(env, ids, event);
      attempted += result.attempted;
      failed += result.failed;
    }
    const page = rows.results ?? [];
    if (page.length < pageSize) break;
    const next = page[page.length - 1]?.account_id;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return { attempted, failed };
}
