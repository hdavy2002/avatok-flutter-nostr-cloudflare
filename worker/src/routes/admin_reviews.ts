// [REVIEW-MOD-1 2026-09-06] Admin moderation queue for reviews.
//
// Owner decision 2026-09-06: a review written by a buyer goes to an admin first;
// only an approved one appears on the listing page or counts towards a rating.
// Schema: worker/migrations/2026-09-06-review-moderation.sql. The public reader
// side of the same rule lives in routes/reviews.ts (`status='approved'` on every
// query) — these two files are the only writers of `reviews.status`.
//
// Same shape as the listing queue next door (routes/admin_listings.ts): requireAdmin,
// an admin_audit row per action, and a PostHog event. "Who did what" was the
// owner's requirement for listings and it applies identically here.
import type { Env } from "../types";
import { json } from "../util";
import { requireAdmin } from "./admin_money";
import { track } from "../hooks";
import { notifyUser } from "../notify";
import { recomputeReviewAggregates } from "./reviews";

const APP = "admin_reviews";

const STATUSES = ["pending", "approved", "rejected"] as const;
type ReviewStatus = (typeof STATUSES)[number];

function safeTrack(env: Env, uid: string, event: string, props: Record<string, unknown>): void {
  // A telemetry failure must never fail a moderation action. hooks.ts track()
  // takes (env, uid, event, app_name, props) — a short call silently corrupts the
  // payload, which is how a prod alert shipped malformed on 2026-08-01.
  try { void track(env, uid, event, APP, props); } catch { /* best-effort */ }
}

// GET /api/admin/reviews?status=pending&limit=
//
// Returns the review WITH the context an admin needs to judge it without opening
// anything else: which listing, whose review, and whether they actually attended.
// A queue that makes you go and look things up is a queue nobody works.
export async function adminReviews(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") || "pending";
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(url.searchParams.get("limit"))) || 100));

  const where: string[] = [];
  const binds: unknown[] = [];
  if (statusParam !== "all") {
    if (!STATUSES.includes(statusParam as ReviewStatus)) return json({ error: "bad status" }, 400);
    where.push(`rv.status=?${binds.length + 1}`);
    binds.push(statusParam);
  }
  binds.push(limit);

  const rs = await env.DB_META.prepare(
    `SELECT rv.id, rv.listing_id, rv.author_id, rv.creator_id, rv.rating, rv.body,
            rv.verified_attendee, rv.status, rv.moderation_reason, rv.moderated_at, rv.moderated_by,
            rv.created_at, rv.helpful_count, rv.creator_reply,
            l.title AS listing_title, l.kind AS listing_kind, l.status AS listing_status,
            au.display_name AS author_name, au.handle AS author_handle, au.avatar_url AS author_avatar,
            cu.display_name AS creator_name, cu.handle AS creator_handle,
            mu.display_name AS moderator_name
       FROM reviews rv
       LEFT JOIN listings l ON l.id = rv.listing_id
       LEFT JOIN users au ON au.uid = rv.author_id
       LEFT JOIN users cu ON cu.uid = rv.creator_id
       LEFT JOIN users mu ON mu.uid = rv.moderated_by
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY rv.created_at DESC
      LIMIT ?${binds.length}`,
  ).bind(...binds).all<any>();

  const items = (rs.results ?? []).map((r) => ({
    id: String(r.id),
    listing: { id: r.listing_id, title: r.listing_title ?? "(listing deleted)", kind: r.listing_kind ?? null, status: r.listing_status ?? null },
    author: {
      uid: r.author_id,
      // Plain-English identity, not a uid — the same "give me names I understand"
      // rule the listing queue follows (islands/admin/labels.ts).
      name: r.author_name || r.author_handle || "an AvaTOK user",
      handle: r.author_handle ?? null,
      avatar_url: r.author_avatar ?? null,
    },
    creator: { uid: r.creator_id, name: r.creator_name || r.creator_handle || "the host" },
    rating: Number(r.rating),
    body: r.body ?? "",
    verified_attendee: !!r.verified_attendee,
    status: String(r.status ?? "approved"),
    moderation_reason: r.moderation_reason ?? null,
    moderated_at: r.moderated_at ?? null,
    moderated_by_name: r.moderator_name ?? null,
    helpful_count: Number(r.helpful_count ?? 0),
    creator_reply: r.creator_reply ?? null,
    created_at: r.created_at,
  }));

  // Counts for the filter chips — always over ALL statuses, so the pending badge
  // is right no matter which filter is being viewed.
  const countRows = await env.DB_META.prepare(
    "SELECT status, COUNT(*) n FROM reviews GROUP BY status",
  ).all<any>();
  const counts: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
  for (const c of countRows.results ?? []) {
    const k = String(c.status ?? "approved");
    if (k in counts) counts[k] = Number(c.n);
  }

  return json({ items, counts, statuses: STATUSES });
}

// POST /api/admin/reviews/:id { action: 'approve' | 'reject', reason? }
export async function adminReviewAction(req: Request, env: Env, reviewId: string): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const adminId = a.uid;
  const b = (await req.json().catch(() => ({}))) as any;
  const action = String(b.action ?? "");
  if (action !== "approve" && action !== "reject") return json({ error: "action must be approve or reject" }, 400);
  const reason = b.reason ? String(b.reason).slice(0, 500) : null;
  // A rejection with no reason is useless to the author and unauditable later.
  if (action === "reject" && !reason) return json({ error: "reason required to reject" }, 400);

  const db = env.DB_META;
  const rv = await db.prepare(
    "SELECT id, listing_id, creator_id, author_id, rating, status FROM reviews WHERE id=?1",
  ).bind(reviewId).first<any>();
  if (!rv) return json({ error: "not found" }, 404);

  const previous = String(rv.status ?? "approved");
  const next: ReviewStatus = action === "approve" ? "approved" : "rejected";
  const now = Date.now();

  await db.prepare(
    "UPDATE reviews SET status=?2, moderated_by=?3, moderated_at=?4, moderation_reason=?5 WHERE id=?1",
  ).bind(reviewId, next, adminId, now, reason).run();

  // Both directions matter: approving ADDS the rating to the average, rejecting a
  // previously-approved review takes it back out. Recompute rather than adjust —
  // a counter that drifts is the bug class this project keeps paying for.
  await recomputeReviewAggregates(db, String(rv.listing_id), String(rv.creator_id), now);

  // ⚠️ admin_audit lives in DB_WALLET (migrations/wallet_ledger.sql:38), NOT in
  // DB_META where `reviews` is. Every other admin route writes it there too
  // (admin_money.ts:28, admin_listings.ts:348). Aiming this at DB_META compiles,
  // deploys green, and throws at runtime into the catch below — i.e. silently no
  // audit trail at all, which is the one thing this row exists to prevent.
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(
      crypto.randomUUID(), adminId, `review_${action}`, `review:${reviewId}`,
      JSON.stringify({ listing_id: rv.listing_id, author_id: rv.author_id, rating: rv.rating, previous_status: previous, next_status: next, reason }),
      now,
    ).run();
  } catch { console.error("[admin_audit] write failed", `review_${action}`); }

  // Tell the people it concerns — the host only on an approval (a review they can
  // now see), the author either way (published, or turned down and why).
  if (next === "approved") {
    try {
      await notifyUser(env, String(rv.creator_id), {
        type: "social", title: `New ${Number(rv.rating)}★ review`,
        data: { deeplink: `/explore/listing/${rv.listing_id}` },
      });
    } catch { /* best-effort */ }
    try {
      await notifyUser(env, String(rv.author_id), {
        type: "social", title: "Your review is live",
        data: { deeplink: `/explore/listing/${rv.listing_id}` },
      });
    } catch { /* best-effort */ }
  } else {
    try {
      await notifyUser(env, String(rv.author_id), {
        type: "social", title: "Your review was not published", body: reason ?? undefined,
        data: { deeplink: `/explore/listing/${rv.listing_id}` },
      });
    } catch { /* best-effort */ }
  }

  safeTrack(env, adminId, "admin_review_moderated", {
    review_id: reviewId, listing_id: rv.listing_id, action,
    previous_status: previous, next_status: next, rating: Number(rv.rating), has_reason: !!reason,
  });

  return json({ ok: true, id: reviewId, status: next, moderated_at: now, moderation_reason: reason });
}
