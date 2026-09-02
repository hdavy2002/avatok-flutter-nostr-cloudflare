// [LIST-CONTENT-2] Reviews trust + engagement — createReview (replacement),
// replyReview, helpfulReview, listReviews.
//
// Contract: Specs/SPEC-2026-09-02-LISTING-TRUST-AND-VIBE.md §1 row 5, §4.1, §4.6.
// Schema: worker/migrations/2026-09-02-reviews-trust.sql (ALTERs on `reviews` +
// new `review_helpful` table). Base `reviews` table: migrations/listings.sql:53-64.
// Legacy `reply`/`reply_at` columns come from migrations/phase8_verse.sql and are
// still read by listings.ts's getListing() — replyReview() below dual-writes them
// alongside the new `creator_reply`/`creator_reply_at` columns so neither reader
// goes stale (see CLAUDE.md's dual-emit precedent for a client-visible rename).
//
// verified_attendee (row 5 of the trust ladder, §1) is set SERVER-SIDE from the
// commercial entitlement at write time — never a client-posted flag:
//   - paid session kinds (`live_event`, `consult`) — worker/src/routes/listings.ts
//     KINDS set — must hold a commercial_entitlements row for this listing in ANY
//     state (worker/src/routes/commercial_checkout.ts CheckoutKind = "live_event" |
//     "consult_1to1") or the review is refused 403 `not_attendee`. verified_attendee
//     is 1 only when that entitlement reached a finished state: `state='consumed'`
//     (see the ('reserved','held','active','consumed') lifecycle used throughout
//     commercial_checkout.ts / commercial_stream_sessions.ts / commercial_lifecycle.ts).
//   - older listing kinds (`sell`, `buy`, `social`) never write commercial
//     entitlements. They keep the pre-existing bookings-table attendance gate
//     (a confirmed/completed booking whose window has passed) and are always
//     flagged verified_attendee=0 — the badge is reserved for real paid-session
//     attendance, not a generic booking.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb, metaSession } from "../db/shard";
import { track } from "../hooks";
import { brainIngest } from "../lib/brain_ingest";
import { notifyUser } from "../notify";

const APP = "avaexplore"; // matches routes/listings.ts

/** Optional auth: a uid when a valid token rides the request, else null (guest).
 *  Local copy of routes/listings.ts's maybeUid (not exported there). */
async function maybeUid(req: Request, env: Env): Promise<string | null> {
  const hasTok = !!req.headers.get("authorization") || !!new URL(req.url).searchParams.get("token");
  if (!hasTok) return null;
  const ctx = await requireUser(req, env);
  return isFail(ctx) ? null : ctx.uid;
}

// Listing kinds that run through GetStream commercial checkout and therefore have
// a commercial_entitlements row to check. Mirrors routes/listings.ts's KINDS set,
// restricted to the two that ever produce an entitlement.
const PAID_SESSION_KINDS = new Set(["live_event", "consult"]);

/** listings.kind -> commercial_entitlements.kind (CheckoutKind in commercial_checkout.ts). */
function entitlementKindFor(listingKind: string): "live_event" | "consult_1to1" {
  return listingKind === "live_event" ? "live_event" : "consult_1to1";
}

function parsePhotoKeys(env: Env, raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // Same "raw key -> blossom.avatok.ai URL, client applies /cdn-cgi/image/…"
    // pattern as routes/affiliate_assets.ts's assetUrl().
    return arr.filter((k) => typeof k === "string").slice(0, 3).map((k) => `${env.BLOSSOM_BASE_URL}/${k}`);
  } catch {
    return [];
  }
}

// POST /api/listings/:id/reviews {rating, body?, photo_keys?}
export async function createReview(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const rating = Math.trunc(Number(b.rating));
  if (!(rating >= 1 && rating <= 5)) return json({ error: "rating 1–5 required" }, 400);

  // photo_keys — optional, <=3 R2 keys, each must be a key THIS caller's own
  // /upload/public produced (routes/media.ts userKey(uid,"public",hash) ->
  // "u/<uid>/public/<hash>"). Anything else is refused outright rather than
  // silently dropped, so a bad client integration surfaces immediately.
  const rawPhotos = Array.isArray(b.photo_keys) ? b.photo_keys : [];
  if (rawPhotos.length > 3) return json({ error: "invalid_photo_keys" }, 400);
  const photoPrefix = `u/${ctx.uid}/public/`;
  for (const k of rawPhotos) {
    if (typeof k !== "string" || !k.startsWith(photoPrefix)) return json({ error: "invalid_photo_keys" }, 400);
  }
  const photoKeysJson = rawPhotos.length ? JSON.stringify(rawPhotos) : null;

  const db = metaDb(env);
  const l = await db.prepare("SELECT creator_id, status, kind FROM listings WHERE id=?1").bind(id).first<any>();
  if (!l) return json({ error: "not found" }, 404);
  if (l.creator_id === ctx.uid) return json({ error: "cannot review your own listing" }, 400);

  const kind = String(l.kind ?? "");
  let verifiedAttendee = 0;

  if (PAID_SESSION_KINDS.has(kind)) {
    const entKind = entitlementKindFor(kind);
    let entAny: unknown = null;
    let entConsumed: unknown = null;
    try {
      entAny = await db.prepare(
        "SELECT 1 FROM commercial_entitlements WHERE kind=?1 AND listing_id=?2 AND account_id=?3 LIMIT 1",
      ).bind(entKind, id, ctx.uid).first();
      entConsumed = await db.prepare(
        "SELECT 1 FROM commercial_entitlements WHERE kind=?1 AND listing_id=?2 AND account_id=?3 AND state='consumed' LIMIT 1",
      ).bind(entKind, id, ctx.uid).first();
    } catch {
      // Pre-migration: commercial_entitlements absent — fail closed (no entitlement).
    }
    if (!entAny) return json({ error: "not_attendee" }, 403);
    verifiedAttendee = entConsumed ? 1 : 0;
  } else {
    // Older listing kinds (sell/buy/social) — unchanged pre-existing gate: a
    // confirmed/completed booking whose window has passed. Never verified.
    const bk = await db.prepare(
      "SELECT 1 FROM bookings WHERE listing_id=?1 AND buyer_id=?2 AND status IN ('confirmed','completed') AND ends_at <= ?3",
    ).bind(id, ctx.uid, Date.now()).first();
    if (!bk) return json({ error: "only attendees can review (after the session ends)" }, 403);
  }

  const now = Date.now();
  await db.prepare(
    `INSERT INTO reviews (id, listing_id, creator_id, author_id, rating, body, created_at, verified_attendee, photo_keys)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
     ON CONFLICT(listing_id, author_id) DO UPDATE SET rating=?5, body=?6, created_at=?7, verified_attendee=?8, photo_keys=?9`,
  ).bind(
    crypto.randomUUID(), id, l.creator_id, ctx.uid, rating,
    b.body ? String(b.body).slice(0, 2000) : null, now, verifiedAttendee, photoKeysJson,
  ).run();

  // Averages update on the card AND the channel (acceptance criterion) — unchanged
  // from the prior createReview.
  await db.batch([
    db.prepare(
      `UPDATE listings SET
         rating_avg=(SELECT AVG(rating) FROM reviews WHERE listing_id=?1),
         rating_count=(SELECT COUNT(*) FROM reviews WHERE listing_id=?1), updated_at=?2 WHERE id=?1`,
    ).bind(id, now),
    db.prepare(
      `INSERT INTO creator_profiles (user_id, rating_avg, rating_count, updated_at)
       VALUES (?1, (SELECT AVG(rating) FROM reviews WHERE creator_id=?1), (SELECT COUNT(*) FROM reviews WHERE creator_id=?1), ?2)
       ON CONFLICT(user_id) DO UPDATE SET
         rating_avg=(SELECT AVG(rating) FROM reviews WHERE creator_id=?1),
         rating_count=(SELECT COUNT(*) FROM reviews WHERE creator_id=?1), updated_at=?2`,
    ).bind(l.creator_id, now),
  ]);
  try {
    await notifyUser(env, l.creator_id, {
      type: "social", title: `New ${rating}★ review`, body: b.body ? String(b.body).slice(0, 80) : undefined,
      data: { deeplink: `/explore/listing/${id}` },
    });
  } catch { /* best-effort */ }
  void brainIngest(env, {
    uid: ctx.uid, domain: "listings", kind: "review_left", sourceId: `${ctx.uid}:${id}`,
    text: `Left a ${rating}★ review`, meta: { rating, verified_attendee: verifiedAttendee },
  });
  track(env, ctx.uid, "review_created", APP, { rating, verified_attendee: verifiedAttendee, listing_kind: kind });
  return json({ ok: true, verified_attendee: !!verifiedAttendee });
}

// POST /api/reviews/:id/reply {reply} — creator of the listing only.
export async function replyReview(req: Request, env: Env, reviewId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const reply = String(b.reply ?? b.body ?? "").trim().slice(0, 600);
  if (!reply) return json({ error: "reply required" }, 400);

  const db = metaDb(env);
  const r = await db.prepare("SELECT creator_id, author_id, listing_id FROM reviews WHERE id=?1").bind(reviewId).first<any>();
  if (!r || r.creator_id !== ctx.uid) return json({ error: "not found" }, 404);

  const now = Date.now();
  // Dual-write: creator_reply/creator_reply_at (this change) AND the legacy
  // reply/reply_at (phase8_verse.sql) so routes/listings.ts's getListing(), which
  // still selects rv.reply/rv.reply_at, keeps showing the same reply.
  await db.prepare(
    "UPDATE reviews SET creator_reply=?2, creator_reply_at=?3, reply=?2, reply_at=?3 WHERE id=?1",
  ).bind(reviewId, reply, now).run();

  try {
    await notifyUser(env, String(r.author_id), {
      type: "social", title: "The creator replied to your review", body: reply.slice(0, 80),
      data: { deeplink: `/explore/listing/${r.listing_id}` },
    });
  } catch { /* best-effort */ }
  void brainIngest(env, {
    uid: ctx.uid, domain: "listings", kind: "review_replied", sourceId: `${ctx.uid}:${reviewId}`,
    text: "Replied to a review", meta: { review_id: reviewId },
  });
  track(env, ctx.uid, "review_reply_posted", APP, { review_id: reviewId });
  return json({ ok: true, creator_reply: reply, creator_reply_at: now });
}

// POST /api/reviews/:id/helpful — toggle "helpful" for the caller.
export async function helpfulReview(req: Request, env: Env, reviewId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const db = metaDb(env);
  const rv = await db.prepare("SELECT 1 FROM reviews WHERE id=?1").bind(reviewId).first();
  if (!rv) return json({ error: "not found" }, 404);

  const existing = await db.prepare(
    "SELECT 1 FROM review_helpful WHERE review_id=?1 AND user_id=?2",
  ).bind(reviewId, ctx.uid).first();

  const now = Date.now();
  let markedHelpful: boolean;
  if (existing) {
    await db.batch([
      db.prepare("DELETE FROM review_helpful WHERE review_id=?1 AND user_id=?2").bind(reviewId, ctx.uid),
      db.prepare("UPDATE reviews SET helpful_count=MAX(0, helpful_count-1) WHERE id=?1").bind(reviewId),
    ]);
    markedHelpful = false;
  } else {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO review_helpful (review_id, user_id, created_at) VALUES (?1,?2,?3)").bind(reviewId, ctx.uid, now),
      db.prepare("UPDATE reviews SET helpful_count=helpful_count+1 WHERE id=?1").bind(reviewId),
    ]);
    markedHelpful = true;
  }

  const row = await db.prepare("SELECT helpful_count FROM reviews WHERE id=?1").bind(reviewId).first<any>();
  track(env, ctx.uid, "review_marked_helpful", APP, { review_id: reviewId, marked: markedHelpful });
  return json({ ok: true, marked_helpful: markedHelpful, helpful_count: Number(row?.helpful_count ?? 0) });
}

// GET /api/listings/:id/reviews?cursor=&verified=1&limit= — paginated list.
export async function listReviews(req: Request, env: Env, listingId: string): Promise<Response> {
  const uid = await maybeUid(req, env);
  const url = new URL(req.url);
  const verifiedOnly = url.searchParams.get("verified") === "1";
  const limit = Math.min(50, Math.max(1, Math.trunc(Number(url.searchParams.get("limit"))) || 20));
  const cursorRaw = Number(url.searchParams.get("cursor"));
  const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null;

  const db = metaSession(env);
  const where = ["rv.listing_id=?1"];
  const binds: unknown[] = [listingId];
  let n = 2;
  if (verifiedOnly) where.push("rv.verified_attendee=1");
  if (cursor) { where.push(`rv.created_at < ?${n}`); binds.push(cursor); n++; }
  const limitParam = n;
  binds.push(limit + 1); // fetch one extra to know if there's a next page

  const rows = await db.prepare(
    `SELECT rv.id, rv.author_id, rv.rating, rv.body, rv.verified_attendee, rv.creator_reply, rv.creator_reply_at,
            rv.helpful_count, rv.photo_keys, rv.created_at,
            u.display_name AS author_name, u.avatar_url AS author_avatar
       FROM reviews rv LEFT JOIN users u ON u.uid = rv.author_id
      WHERE ${where.join(" AND ")}
      ORDER BY rv.created_at DESC
      LIMIT ?${limitParam}`,
  ).bind(...binds).all();

  const all = (rows.results ?? []) as any[];
  const hasMore = all.length > limit;
  const page = hasMore ? all.slice(0, limit) : all;

  let markedSet = new Set<string>();
  if (uid && page.length) {
    const ids = page.map((r) => String(r.id));
    const placeholders = ids.map((_, i) => `?${i + 2}`).join(",");
    const marked = await db.prepare(
      `SELECT review_id FROM review_helpful WHERE user_id=?1 AND review_id IN (${placeholders})`,
    ).bind(uid, ...ids).all();
    markedSet = new Set(((marked.results ?? []) as any[]).map((m) => String(m.review_id)));
  }

  const items = page.map((r) => ({
    id: r.id,
    author: { uid: r.author_id, name: r.author_name || "an AvaTOK user", avatar_url: r.author_avatar ?? null },
    rating: Number(r.rating),
    body: r.body ?? "",
    verified_attendee: !!r.verified_attendee,
    creator_reply: r.creator_reply ?? null,
    creator_reply_at: r.creator_reply_at ?? null,
    helpful_count: Number(r.helpful_count ?? 0),
    viewer_marked_helpful: markedSet.has(String(r.id)),
    photos: parsePhotoKeys(env, r.photo_keys),
    created_at: r.created_at,
  }));

  // Histogram + verified_count are ALWAYS computed over every review for this
  // listing (not the current ?verified filter) so the UI's rating breakdown
  // stays stable regardless of which page/filter the caller is viewing.
  const histRows = await db.prepare(
    "SELECT rating, COUNT(*) n FROM reviews WHERE listing_id=?1 GROUP BY rating",
  ).bind(listingId).all();
  const histogram: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  let total = 0;
  for (const h of (histRows.results ?? []) as any[]) {
    const key = String(h.rating);
    if (key in histogram) histogram[key] = Number(h.n);
    total += Number(h.n);
  }
  const verifiedCountRow = await db.prepare(
    "SELECT COUNT(*) n FROM reviews WHERE listing_id=?1 AND verified_attendee=1",
  ).bind(listingId).first<any>();
  const verifiedCount = Number(verifiedCountRow?.n ?? 0);

  return json({
    items,
    next_cursor: hasMore ? page[page.length - 1].created_at : null,
    total,
    histogram,
    verified_count: verifiedCount,
    // §4.6 — with fewer than 3 reviews, still return the items but tell the
    // client not to render an average rating (too noisy at n<3).
    show_rating: total >= 3,
  });
}
