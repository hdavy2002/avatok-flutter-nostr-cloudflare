// [WALLET-ACTIVITY-DETAIL-1 2026-09-11] "What was this money for?"
//
// The wallet listed rows as `refund +100` / `spend -555` / `ai_settle -1` and nothing
// else, so a user could not tell which show a refund came from, which creator it was
// for, or why it happened. wallet_transactions only carries `ref` (an order id, an AI
// job id, a Stripe session…) — the facts a person wants live in DB_META (orders,
// listings, users, refund receipts). This module joins the two, scoped to the caller.
//
// Two entry points:
//   orderContextFor()   — batch: order ref → listing title, for statement row labels.
//   activityDetailFor() — one row, everything we know, for the tap-to-expand panel.
import type { Env } from "../types";
import { metaDb } from "../db/shard";

type OrderRow = {
  id: string;
  kind: string | null;
  status: string | null;
  buyer_id: string | null;
  creator_id: string | null;
  booking_id: string | null;
  listing_id: string | null;
  listing_title: string | null;
  listing_kind: string | null;
  listing_slug: string | null;
  listing_starts_at: number | null;
  listing_duration_min: number | null;
  listing_timezone: string | null;
  creator_name: string | null;
  creator_handle: string | null;
  buyer_name: string | null;
  buyer_handle: string | null;
  booking_starts_at: number | null;
};

const ORDER_SELECT = `
  SELECT o.id, o.kind, o.status, o.buyer_id, o.creator_id, o.booking_id,
         l.id listing_id, l.title listing_title, l.kind listing_kind, l.slug listing_slug,
         l.starts_at listing_starts_at, l.duration_min listing_duration_min, l.timezone listing_timezone,
         cu.display_name creator_name, cu.handle creator_handle,
         bu.display_name buyer_name, bu.handle buyer_handle,
         b.starts_at booking_starts_at
    FROM orders o
    LEFT JOIN listings l ON l.id=o.listing_id
    LEFT JOIN users cu ON cu.uid=o.creator_id
    LEFT JOIN users bu ON bu.uid=o.buyer_id
    LEFT JOIN bookings b ON b.id=o.booking_id`;

/** A wallet ref that can be an order id. Order ids are opaque, so this only filters junk. */
function looksLikeOrderRef(ref: string | null | undefined): ref is string {
  const r = String(ref ?? "");
  return r.length >= 8 && r.length <= 200 && !r.startsWith("aijob:") && !r.startsWith("cs_") && !r.startsWith("adj:");
}

/** Batch: order ref → the listing title, only for orders the caller is a party to. */
export async function orderContextFor(env: Env, uid: string, refs: string[]): Promise<Map<string, { title: string | null; kind: string | null }>> {
  const out = new Map<string, { title: string | null; kind: string | null }>();
  const ids = [...new Set(refs.filter(looksLikeOrderRef))].slice(0, 100);
  if (!ids.length) return out;
  try {
    const ph = ids.map((_, i) => `?${i + 2}`).join(",");
    const rs = await metaDb(env).prepare(
      `SELECT o.id, l.title, COALESCE(o.kind, l.kind) kind FROM orders o LEFT JOIN listings l ON l.id=o.listing_id
        WHERE (o.buyer_id=?1 OR o.creator_id=?1) AND o.id IN (${ph})`,
    ).bind(uid, ...ids).all<{ id: string; title: string | null; kind: string | null }>();
    for (const r of rs.results ?? []) out.set(String(r.id), { title: r.title ?? null, kind: r.kind ?? null });
  } catch { /* META unavailable — labels fall back to the generic type label */ }
  return out;
}

const REFUND_REASONS: Record<string, string> = {
  creator_no_show: "The host didn't start the show, so you were refunded automatically.",
  creator_cancel: "The host cancelled.",
  buyer_cancel_within_policy_window: "You cancelled within the free-cancellation window.",
  late_cancel: "You cancelled after the free-cancellation window.",
  provider_outage: "A technical problem on our side stopped the session.",
  insufficient_delivery_evidence: "The session could not be confirmed as delivered.",
  listing_cancelled: "The listing was taken down.",
};

function kindNoun(kind: string | null | undefined): string {
  switch (String(kind ?? "")) {
    case "live_event": return "live show";
    case "consult": case "consult_1to1": return "1:1 session";
    case "sell": case "buy": case "social": return "marketplace deal";
    default: return "booking";
  }
}

function listingUrl(o: OrderRow): string | null {
  if (!o.listing_id) return null;
  return o.creator_handle && o.listing_slug
    ? `https://avatok.ai/${encodeURIComponent(o.creator_handle)}/${encodeURIComponent(o.listing_slug)}`
    : `https://avatok.ai/l/${encodeURIComponent(o.listing_id)}`;
}

export type ActivityDetail = {
  id: string;
  ts: number;
  tokens: number;
  type: string;
  status: string;
  balance_after: number | null;
  activity: string;
  title: string;
  reason: string | null;
  listing: { id: string; title: string | null; kind: string | null; url: string | null; starts_at: number | null; timezone: string | null } | null;
  counterparty: { role: "creator" | "buyer"; name: string | null; handle: string | null; url: string | null } | null;
  order_id: string | null;
  reference: string | null;
  refunded_to: string | null;
};

/**
 * Everything known about one of the caller's wallet rows. `baseLabel` is the generic
 * statement label (labelFor) so rows with no order behind them still read as a sentence.
 */
export async function activityDetailFor(
  env: Env,
  uid: string,
  row: { id: string; type: string; amount: number; balance_after: number | null; app_name: string | null; ref: string | null; status: string | null; created_at: number; context: string | null; counterparty_name: string | null },
  baseLabel: string,
): Promise<ActivityDetail> {
  const type = String(row.type || "");
  const tokens = Number(row.amount);
  const detail: ActivityDetail = {
    id: row.id,
    ts: Number(row.created_at),
    tokens,
    type,
    status: type === "refund" ? "refunded" : String(row.status || "").toLowerCase() === "pending" ? "pending" : "completed",
    balance_after: row.balance_after == null ? null : Number(row.balance_after),
    activity: baseLabel,
    title: row.context || baseLabel,
    reason: null,
    listing: null,
    counterparty: row.counterparty_name ? { role: tokens >= 0 ? "buyer" : "creator", name: row.counterparty_name, handle: null, url: null } : null,
    order_id: null,
    reference: row.ref,
    refunded_to: null,
  };
  if (!looksLikeOrderRef(row.ref)) return detail;

  let order: OrderRow | null = null;
  try {
    order = await metaDb(env).prepare(`${ORDER_SELECT} WHERE o.id=?1 AND (o.buyer_id=?2 OR o.creator_id=?2)`)
      .bind(row.ref, uid).first<OrderRow>();
  } catch { order = null; }
  if (!order) return detail;

  const iAmBuyer = order.buyer_id === uid;
  const noun = kindNoun(order.kind ?? order.listing_kind);
  detail.order_id = order.id;
  detail.listing = order.listing_id ? {
    id: order.listing_id,
    title: order.listing_title,
    kind: order.listing_kind,
    url: listingUrl(order),
    starts_at: order.booking_starts_at ?? order.listing_starts_at ?? null,
    timezone: order.listing_timezone ?? "Asia/Kolkata",
  } : null;
  detail.counterparty = iAmBuyer
    ? { role: "creator", name: order.creator_name, handle: order.creator_handle, url: order.creator_handle ? `https://avatok.ai/c/${encodeURIComponent(order.creator_handle)}` : null }
    : { role: "buyer", name: order.buyer_name, handle: order.buyer_handle, url: null };

  if (type === "refund") {
    detail.activity = `Refund for a ${noun}`;
    detail.refunded_to = "avaTOK wallet";
    try {
      const receipt = await metaDb(env).prepare(
        "SELECT reason, actor FROM commercial_refund_receipts WHERE order_id=?1 LIMIT 1",
      ).bind(order.id).first<{ reason: string | null; actor: string | null }>();
      const key = String(receipt?.reason ?? "");
      detail.reason = REFUND_REASONS[key] ?? (key ? key.replace(/_/g, " ") : null);
    } catch { /* no receipt table on this env */ }
  } else if (tokens < 0) {
    detail.activity = order.kind === "live_event" ? "Ticket for a live show" : `Payment for a ${noun}`;
  } else {
    detail.activity = iAmBuyer ? `Credit for a ${noun}` : `Earnings from a ${noun}`;
  }
  detail.title = order.listing_title ? `${detail.activity} · ${order.listing_title}` : detail.activity;
  return detail;
}
