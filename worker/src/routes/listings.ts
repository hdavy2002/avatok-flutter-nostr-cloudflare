// Phase 6 — Listings pipeline + AvaExplore marketplace + creator channels.
// (PHASE-06.md). Events/consults marketplace; SEPARATE from AvaOLX (digital
// goods). Tables in DB_META (avatok-meta): listings, reviews, creator_profiles,
// creator_follows, listing_promotions, orders, listings_fts, listing_categories.
//
// Creation pipeline (auth, KYC-gated publish):
//   POST   /api/listings                       create draft
//   PUT    /api/listings/:id                   step updates (owner)
//   POST   /api/listings/:id/publish           guards: requireKyc; live → claimBlock (409 conflict)
//   POST   /api/listings/:id/status            owner: live|completed|cancelled (Phase 7 glue)
//   POST   /api/listings/:id/duplicate         A6 — copy, clear date/slot, draft
//   DELETE /api/listings/:id                   cancel + release slot
//   GET    /api/listings/mine                  my listings (any status)
//   GET/POST /api/listings/:id/promotions      A5 — early-bird + promo codes
//   DELETE /api/listings/:id/promotions/:pid
//
// Marketplace reads (PUBLIC — A3 guest browsing, no auth required):
//   GET /api/explore?kind=&category=&country=&cursor=
//   GET /api/explore/live-now
//   GET /api/explore/search?q=&…filters…&sort=     A1 — FTS5 search
//   GET /api/explore/categories
//   GET /api/listings/:id                          details + creator card + reviews p1
//   GET /api/creators/:id                          channel page
//
// Social + money glue (auth):
//   POST   /api/listings/:id/book        order + booking + escrow hold + email
//   POST   /api/listings/:id/reviews     attendees only
//   POST/DELETE /api/creators/:id/follow A2 (+ fan-out notify on publish/go-live)
//   POST/DELETE /api/creators/:id/block  A4 buyer-side block
//   PUT    /api/creators/me              A7 channel editor
//   POST   /api/report                   A4 → user_reports pipeline
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail, requireKyc } from "../authz";
import { metaDb, metaSession, moderationDb } from "../db/shard";
import { claimBlock, releaseBlocks, policyViolation } from "../cal/engine";
import { hold, refund } from "../ledger";
import { LANGS as TRL_LANGS, RATE_PER_MIN as TRL_RATE } from "./translate";
import { track, brainFact } from "../hooks";
import { recordView, trackImpressions, geoOf } from "./insights";
import { guardWrite } from "./moderate"; // save-time content validation (Nemotron)
import { notifyUser } from "../notify";
import { emailBookingConfirmed } from "../cal/emails";

const APP = "avaexplore";
// live_event/consult = creator services; sell/buy/social = AvaMarketplace listings.
const KINDS = new Set(["live_event", "consult", "sell", "buy", "social"]);
const MARKET_KINDS = new Set(["sell", "buy", "social"]);
const CAPACITIES = new Set([1, 10, 20]);
const FANOUT_DAILY_CAP = 2;       // A2 anti-spam
const FANOUT_MAX_FOLLOWERS = 500;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Optional auth: a uid when a valid token rides the request, else null (guest). */
async function maybeUid(req: Request, env: Env): Promise<string | null> {
  const hasTok = !!req.headers.get("authorization") || !!new URL(req.url).searchParams.get("token");
  if (!hasTok) return null;
  const ctx = await requireUser(req, env);
  return isFail(ctx) ? null : ctx.uid;
}

async function nameOf(env: Env, uid: string): Promise<string> {
  const r = await metaDb(env).prepare("SELECT display_name, handle FROM users WHERE uid=?1").bind(uid).first<any>();
  return r?.display_name || r?.handle || "an AvaTOK creator";
}

function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

const CARD_SELECT = `
  SELECT l.id, l.creator_id, l.kind, l.title, l.description, l.category, l.price,
         l.currency_display, l.country, l.adults_only, l.badges, l.cover_media,
         l.starts_at, l.duration_min, l.capacity, l.status, l.joined_count,
         l.translation_enabled, l.spoken_lang,
         l.rating_avg, l.rating_count, l.created_at,
         u.handle AS creator_handle, u.display_name AS creator_name, u.avatar_url AS creator_avatar,
         (SELECT k.status FROM kyc_status k WHERE k.uid = l.creator_id) AS creator_kyc
    FROM listings l LEFT JOIN users u ON u.uid = l.creator_id`;

function activePromoPct(promos: any[], now: number, code?: string | null): { pct: number; promo: any | null } {
  let best: any = null;
  for (const p of promos) {
    if (p.ends_at && now > Number(p.ends_at)) continue;
    if (p.max_uses != null && Number(p.used) >= Number(p.max_uses)) continue;
    if (p.kind === "promo_code" && (!code || String(p.code || "").toUpperCase() !== String(code).toUpperCase())) continue;
    if (!best || Number(p.pct_off) > Number(best.pct_off)) best = p;
  }
  return best ? { pct: Math.min(100, Math.max(0, Number(best.pct_off))), promo: best } : { pct: 0, promo: null };
}

function shapeCard(r: any, promosByListing?: Map<string, any[]>) {
  const now = Date.now();
  const promos = promosByListing?.get(r.id) ?? [];
  const { pct } = activePromoPct(promos.filter((p) => p.kind === "early_bird"), now);
  const oneLiner = String(r.description || "").split("\n")[0].slice(0, 120);
  return {
    id: r.id, creator_id: r.creator_id, kind: r.kind, title: r.title,
    one_liner: oneLiner, category: r.category,
    price: Number(r.price), effective_price: pct > 0 ? Math.round(Number(r.price) * (100 - pct) / 100) : Number(r.price),
    promo_pct: pct, currency_display: r.currency_display ?? "USD",
    country: r.country ?? null, adults_only: !!r.adults_only,
    badges: parseJson(r.badges, [] as unknown[]),
    cover_media: parseJson(r.cover_media, [] as unknown[]),
    starts_at: r.starts_at ?? null, duration_min: r.duration_min ?? null,
    capacity: r.capacity ?? null, status: r.status,
    translation_enabled: !!r.translation_enabled, spoken_lang: r.spoken_lang ?? null,
    joined_count: Number(r.joined_count ?? 0),
    rating_avg: r.rating_avg != null ? Number(r.rating_avg) : null,
    rating_count: Number(r.rating_count ?? 0),
    creator: {
      uid: r.creator_id, handle: r.creator_handle ?? null,
      name: r.creator_name ?? null, avatar_url: r.creator_avatar ?? null,
      kyc_verified: r.creator_kyc === "verified",                     // A4 trust badge
    },
  };
}

/** Fetch early-bird promos for a page of listing ids (one IN query, no N+1). */
async function promosFor(env: Env, ids: string[]): Promise<Map<string, any[]>> {
  const map = new Map<string, any[]>();
  if (!ids.length) return map;
  const rs = await metaSession(env).prepare(
    `SELECT id, listing_id, kind, pct_off, code, max_uses, used, ends_at FROM listing_promotions
      WHERE listing_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
  ).bind(...ids).all();
  for (const p of (rs.results ?? []) as any[]) {
    if (!map.has(p.listing_id)) map.set(p.listing_id, []);
    map.get(p.listing_id)!.push(p);
  }
  return map;
}

/** Keep the FTS row in sync (listings are low-write → replace-on-write). */
async function ftsSync(env: Env, id: string, remove = false): Promise<void> {
  const db = metaDb(env);
  await db.prepare("DELETE FROM listings_fts WHERE listing_id=?1").bind(id).run();
  if (remove) return;
  const l = await db.prepare(
    `SELECT l.title, l.description, l.category, u.display_name, u.handle
       FROM listings l LEFT JOIN users u ON u.uid=l.creator_id WHERE l.id=?1 AND l.status IN ('published','live')`,
  ).bind(id).first<any>();
  if (!l) return;
  await db.prepare(
    "INSERT INTO listings_fts (listing_id, title, description, creator_name, category) VALUES (?1,?2,?3,?4,?5)",
  ).bind(id, l.title ?? "", l.description ?? "", `${l.display_name ?? ""} ${l.handle ?? ""}`.trim(), l.category ?? "").run();
}

/**
 * A2 fan-out notify: push every follower with notify=1 on publish / go-live.
 * Capped at FANOUT_DAILY_CAP per creator per day (anti-spam). Notifications
 * feed rows are batch-inserted; FCM pushes ride Q_PUSH in chunks of 100.
 */
export async function fanout(env: Env, creatorId: string, title: string, body: string, deeplink: string): Promise<{ sent: number; capped: boolean }> {
  const db = metaDb(env);
  const day = new Date().toISOString().slice(0, 10);
  const cur = await db.prepare("SELECT count FROM fanout_log WHERE creator_id=?1 AND day=?2").bind(creatorId, day).first<{ count: number }>();
  if ((cur?.count ?? 0) >= FANOUT_DAILY_CAP) return { sent: 0, capped: true };
  await db.prepare(
    "INSERT INTO fanout_log (creator_id, day, count) VALUES (?1,?2,1) ON CONFLICT(creator_id, day) DO UPDATE SET count=count+1",
  ).bind(creatorId, day).run();

  const rs = await db.prepare(
    "SELECT follower_id FROM creator_follows WHERE creator_id=?1 AND notify=1 LIMIT ?2",
  ).bind(creatorId, FANOUT_MAX_FOLLOWERS).all();
  const followers = ((rs.results ?? []) as any[]).map((r) => String(r.follower_id));
  if (!followers.length) return { sent: 0, capped: false };

  const now = Date.now();
  const data = JSON.stringify({ deeplink });
  // In-app feed rows — one D1 batch.
  await db.batch(followers.map((uid) => db.prepare(
    "INSERT INTO notifications (id, uid, type, title, body, data, read, created_at) VALUES (?1,?2,'social',?3,?4,?5,0,?6)",
  ).bind(crypto.randomUUID(), uid, title, body, data, now)));
  // FCM wake — Q_PUSH in chunks of 100.
  for (let i = 0; i < followers.length; i += 100) {
    await env.Q_PUSH.sendBatch(followers.slice(i, i + 100).map((uid) => ({ body: { kind: "notify", to: uid, fromName: title.slice(0, 60), ts: now } })));
  }
  return { sent: followers.length, capped: false };
}

// ---------------------------------------------------------------------------
// creation pipeline
// ---------------------------------------------------------------------------

const EDITABLE = ["title", "description", "category", "price", "currency_display", "country", "adults_only", "badges", "cover_media", "starts_at", "duration_min", "capacity", "translation_enabled", "spoken_lang"] as const;

function normFields(b: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (b.title !== undefined) out.title = String(b.title).slice(0, 140);
  if (b.description !== undefined) out.description = String(b.description).slice(0, 8000);
  if (b.category !== undefined) out.category = String(b.category);
  if (b.price !== undefined) out.price = Math.max(0, Math.trunc(Number(b.price) || 0));
  // AvaMarketplace sends price_amount/price_currency (major units, any ISO-4217).
  if (b.price_amount !== undefined && b.price === undefined) out.price = Math.max(0, Math.trunc(Number(b.price_amount) || 0));
  if (b.currency_display !== undefined) out.currency_display = String(b.currency_display).slice(0, 8);
  if (b.price_currency !== undefined && b.currency_display === undefined) out.currency_display = String(b.price_currency).slice(0, 8);
  if (b.country !== undefined) out.country = b.country ? String(b.country).slice(0, 2).toUpperCase() : null;
  if (b.adults_only !== undefined) out.adults_only = b.adults_only ? 1 : 0;
  if (b.badges !== undefined) out.badges = b.badges ? JSON.stringify(b.badges) : null;
  if (b.cover_media !== undefined) {
    // Listing photos: 1–5 (min enforced at publish; max here). Shape: {type,url}.
    const arr = (Array.isArray(b.cover_media) ? b.cover_media : [])
      .filter((m: any) => m && typeof m.url === "string" && /^https:\/\//.test(m.url))
      .slice(0, 5)
      .map((m: any) => ({ type: String(m.type || "image"), url: String(m.url).slice(0, 500) }));
    out.cover_media = arr.length ? JSON.stringify(arr) : null;
  }
  if (b.starts_at !== undefined) out.starts_at = b.starts_at ? Math.trunc(Number(b.starts_at)) : null;
  if (b.duration_min !== undefined) out.duration_min = b.duration_min ? Math.trunc(Number(b.duration_min)) : null;
  if (b.capacity !== undefined) out.capacity = b.capacity ? Math.trunc(Number(b.capacity)) : null;
  // Voice translation options ("Voice translation available" + creator's
  // language of transmission, e.g. 'hi' for Hindi).
  if (b.translation_enabled !== undefined) out.translation_enabled = b.translation_enabled ? 1 : 0;
  if (b.spoken_lang !== undefined) out.spoken_lang = b.spoken_lang ? String(b.spoken_lang).slice(0, 12) : null;
  return out;
}

// POST /api/listings — create a draft.
export async function createListing(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const kind = String(b.kind || "");
  if (!KINDS.has(kind)) return json({ error: "kind must be live_event|consult" }, 400);
  const id = crypto.randomUUID();
  const now = Date.now();
  const f = normFields(b);
  const blocked = await guardWrite(req, env, ctx.uid, APP, [
    { text: f.title as string | undefined, field: "listing_title" },
    { text: f.description as string | undefined, field: "listing_desc" },
  ]);
  if (blocked) return blocked;
  await metaDb(env).prepare(
    `INSERT INTO listings (id, creator_id, kind, title, description, category, price, currency_display,
       country, adults_only, badges, cover_media, starts_at, duration_min, capacity, status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'draft',?16,?16)`,
  ).bind(id, ctx.uid, kind, (f.title as string) ?? "Untitled", f.description ?? null, (f.category as string) ?? "teachers",
    f.price ?? 0, f.currency_display ?? "USD", f.country ?? null, f.adults_only ?? 0, f.badges ?? null,
    f.cover_media ?? null, f.starts_at ?? null, f.duration_min ?? null,
    kind === "consult" ? (f.capacity ?? 1) : null, now).run();
  track(env, ctx.uid, "listing_draft_created", APP, { kind });
  return json({ ok: true, listing_id: id, status: "draft" });
}

// PUT /api/listings/:id — step updates (owner only; drafts and published).
export async function updateListing(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const row = await metaDb(env).prepare("SELECT creator_id, status, kind FROM listings WHERE id=?1").bind(id).first<any>();
  if (!row || row.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  if (row.status === "cancelled" || row.status === "completed") return json({ error: "listing closed" }, 409);
  const f = normFields((await req.json().catch(() => ({}))) as any);
  const keys = (EDITABLE as readonly string[]).filter((k) => k in f);
  if (!keys.length) return json({ error: "nothing to update" }, 400);
  const blocked = await guardWrite(req, env, ctx.uid, APP, [
    { text: f.title as string | undefined, field: "listing_title" },
    { text: f.description as string | undefined, field: "listing_desc" },
  ]);
  if (blocked) return blocked;
  // A published live event's time can't silently move (the slot is claimed) — reject.
  if (row.status !== "draft" && row.kind === "live_event" && ("starts_at" in f || "duration_min" in f)) {
    return json({ error: "cannot move a published event — cancel and re-create" }, 409);
  }
  const sets = keys.map((k, i) => `${k}=?${i + 2}`).join(", ");
  await metaDb(env).prepare(`UPDATE listings SET ${sets}, updated_at=?${keys.length + 2} WHERE id=?1`)
    .bind(id, ...keys.map((k) => f[k]), Date.now()).run();
  if (row.status !== "draft") await ftsSync(env, id);
  return json({ ok: true });
}

// POST /api/listings/:id/publish — KYC gate + slot claim (live) / rules check (consult).
export async function publishListing(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const db = metaDb(env);
  const l = await db.prepare("SELECT * FROM listings WHERE id=?1").bind(id).first<any>();
  if (!l || l.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  if (l.status !== "draft") return json({ error: "already published", status_now: l.status }, 409);

  const isMarket = MARKET_KINDS.has(String(l.kind));
  if (isMarket) {
    // AvaMarketplace (buy/sell/social): no slots, availability, capacity or valid-
    // category-id requirement; photos are optional so the flow is testable now.
    // NOTE: the 3-factor identity gate (video+email+phone) is the pre-public-launch
    // requirement and is intentionally NOT enforced here yet (testing phase).
    if (!l.title) return json({ error: "title required" }, 400);
    const mc = parseJson(l.cover_media, [] as unknown[]);
    if (Array.isArray(mc) && mc.length > 5) return json({ error: "max 5 photos" }, 400);
    if (!(Number(l.price) >= 0)) return json({ error: "bad price" }, 400);
  } else {
    // Creator services (live_event/consult) — KYC + photos + valid category + slot/availability.
    const gate = await requireKyc(env, ctx.uid);
    if (gate) return json({ error: gate.error, reason: "kyc" }, gate.status);
    if (!l.title || !l.category) return json({ error: "title and category required" }, 400);
    // Listing photos are mandatory: 1–5 (owner decision 2026-06-11).
    const covers = parseJson(l.cover_media, [] as unknown[]);
    if (!Array.isArray(covers) || covers.length < 1) {
      return json({ error: "cover_required", detail: "Add at least one photo (up to 5) before publishing." }, 400);
    }
    if (covers.length > 5) return json({ error: "max 5 photos" }, 400);
    const cat = await db.prepare("SELECT 1 FROM listing_categories WHERE id=?1 AND active=1").bind(l.category).first();
    if (!cat) return json({ error: "unknown category" }, 400);
    if (!(Number(l.price) >= 0)) return json({ error: "bad price" }, 400);

    if (l.kind === "live_event") {
      const start = Number(l.starts_at), dur = Number(l.duration_min);
      if (!(start > Date.now()) || !(dur >= 5 && dur <= 480)) return json({ error: "starts_at (future) and duration_min (5–480) required" }, 400);
      // Conflict engine: claim the creator's slot — occupied ⇒ 409 (greyed UX client-side).
      const claim = await claimBlock(env, { userId: ctx.uid, sourceApp: APP, sourceRef: id, start, end: start + dur * 60_000, title: String(l.title) });
      if (!claim.ok) return json({ error: "conflict", conflictWith: claim.conflict }, 409);
    } else {
      if (!CAPACITIES.has(Number(l.capacity))) return json({ error: "capacity must be 1, 10 or 20" }, 400);
      // Consult listings attach to availability_rules — there must be some.
      const rules = await db.prepare("SELECT 1 FROM availability_rules WHERE user_id=?1 LIMIT 1").bind(ctx.uid).first();
      if (!rules) return json({ error: "no_availability", detail: "Set your availability in AvaCalendar before publishing a consult listing." }, 409);
    }
  }

  await db.prepare("UPDATE listings SET status='published', updated_at=?2 WHERE id=?1").bind(id, Date.now()).run();
  // Ensure the channel row exists so follower counts etc. have a home.
  await db.prepare("INSERT INTO creator_profiles (user_id, updated_at) VALUES (?1,?2) ON CONFLICT(user_id) DO NOTHING").bind(ctx.uid, Date.now()).run();
  await ftsSync(env, id);

  const who = await nameOf(env, ctx.uid);
  const fo = await fanout(env, ctx.uid, `${who} just scheduled: ${String(l.title).slice(0, 40)}`,
    l.kind === "live_event" ? "New live event — book your spot" : "New session offering", `/explore/listing/${id}`);
  brainFact(env, ctx.uid, "listing_published", APP, { kind: l.kind, title: l.title, price: l.price });
  track(env, ctx.uid, "listing_published", APP, { kind: l.kind, price: l.price, fanout: fo.sent });
  return json({ ok: true, status: "published", fanout: fo });
}

// POST /api/listings/:id/status {status} — owner glue for live|completed|cancelled.
export async function setListingStatus(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const to = String(b.status || "");
  if (!["live", "completed", "cancelled"].includes(to)) return json({ error: "status must be live|completed|cancelled" }, 400);
  const db = metaDb(env);
  const l = await db.prepare("SELECT creator_id, status, title, kind FROM listings WHERE id=?1").bind(id).first<any>();
  if (!l || l.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  if (l.status === "draft") return json({ error: "publish first" }, 409);
  await db.prepare("UPDATE listings SET status=?2, updated_at=?3 WHERE id=?1").bind(id, to, Date.now()).run();
  if (to === "cancelled" || to === "completed") { await releaseBlocks(env, APP, id); await ftsSync(env, id, true); }
  if (to === "live") {
    const who = await nameOf(env, ctx.uid);
    await fanout(env, ctx.uid, `${who} is LIVE now`, String(l.title).slice(0, 60), `/explore/listing/${id}`);
  }
  track(env, ctx.uid, "listing_status_changed", APP, { to });
  return json({ ok: true, status: to });
}

// POST /api/listings/:id/duplicate — A6: copy everything, clear date/slot, draft.
export async function duplicateListing(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const db = metaDb(env);
  const l = await db.prepare("SELECT * FROM listings WHERE id=?1").bind(id).first<any>();
  if (!l || l.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  const nid = crypto.randomUUID();
  const now = Date.now();
  await db.prepare(
    `INSERT INTO listings (id, creator_id, kind, title, description, category, price, currency_display,
       country, adults_only, badges, cover_media, starts_at, duration_min, capacity, translation_enabled, spoken_lang, status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,NULL,?13,?14,?15,?16,'draft',?17,?17)`,
  ).bind(nid, ctx.uid, l.kind, l.title, l.description, l.category, l.price, l.currency_display,
    l.country, l.adults_only, l.badges, l.cover_media, l.duration_min, l.capacity,
    l.translation_enabled ?? 0, l.spoken_lang ?? null, now).run();
  track(env, ctx.uid, "listing_duplicated", APP, {});
  return json({ ok: true, listing_id: nid });
}

// DELETE /api/listings/:id — cancel + release the slot.
export async function cancelListing(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const db = metaDb(env);
  const l = await db.prepare("SELECT creator_id FROM listings WHERE id=?1").bind(id).first<any>();
  if (!l || l.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  await db.prepare("UPDATE listings SET status='cancelled', updated_at=?2 WHERE id=?1").bind(id, Date.now()).run();
  await releaseBlocks(env, APP, id);
  await ftsSync(env, id, true);
  return json({ ok: true });
}

// GET /api/listings/mine — the creator's own listings, all statuses.
export async function myListings(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const rs = await metaSession(env).prepare(
    `${CARD_SELECT} WHERE l.creator_id=?1 ORDER BY l.updated_at DESC LIMIT 100`,
  ).bind(ctx.uid).all();
  const rows = (rs.results ?? []) as any[];
  const promos = await promosFor(env, rows.map((r) => r.id));
  return json({ listings: rows.map((r) => shapeCard(r, promos)) });
}

// ---------------------------------------------------------------------------
// A5 promotions
// ---------------------------------------------------------------------------

export async function listingPromotions(req: Request, env: Env, id: string): Promise<Response> {
  if (req.method === "GET") {
    const rs = await metaSession(env).prepare(
      "SELECT id, kind, pct_off, code, max_uses, used, ends_at FROM listing_promotions WHERE listing_id=?1",
    ).bind(id).all();
    return json({ promotions: rs.results ?? [] });
  }
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const own = await metaDb(env).prepare("SELECT creator_id FROM listings WHERE id=?1").bind(id).first<any>();
  if (!own || own.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  const b = (await req.json().catch(() => ({}))) as any;
  const kind = String(b.kind || "");
  const pct = Math.trunc(Number(b.pct_off));
  if (!["early_bird", "promo_code"].includes(kind)) return json({ error: "kind must be early_bird|promo_code" }, 400);
  if (!(pct >= 1 && pct <= 100)) return json({ error: "pct_off 1–100 required" }, 400);
  const code = kind === "promo_code" ? String(b.code || "").trim().toUpperCase() : null;
  if (kind === "promo_code" && !code) return json({ error: "code required" }, 400);
  const pid = crypto.randomUUID();
  await metaDb(env).prepare(
    "INSERT INTO listing_promotions (id, listing_id, kind, pct_off, code, max_uses, used, ends_at) VALUES (?1,?2,?3,?4,?5,?6,0,?7)",
  ).bind(pid, id, kind, pct, code, b.max_uses ? Math.trunc(Number(b.max_uses)) : null, b.ends_at ? Math.trunc(Number(b.ends_at)) : null).run();
  track(env, ctx.uid, "listing_promo_created", APP, { kind, pct });
  return json({ ok: true, promotion_id: pid });
}

export async function deletePromotion(req: Request, env: Env, id: string, pid: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const own = await metaDb(env).prepare("SELECT creator_id FROM listings WHERE id=?1").bind(id).first<any>();
  if (!own || own.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  await metaDb(env).prepare("DELETE FROM listing_promotions WHERE id=?1 AND listing_id=?2").bind(pid, id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// marketplace reads (public — guest browsing, A3)
// ---------------------------------------------------------------------------

export async function exploreCategories(env: Env): Promise<Response> {
  const rs = await metaSession(env).prepare(
    "SELECT id, label, emoji FROM listing_categories WHERE active=1 ORDER BY sort",
  ).all();
  return json({ categories: rs.results ?? [] });
}

/** WHERE fragment hiding listings from creators the (authed) caller blocked. */
function blockFilter(uid: string | null, binds: unknown[], where: string[]): void {
  if (!uid) return;
  binds.push(uid);
  where.push(`l.creator_id NOT IN (SELECT blocked_npub FROM blocks WHERE uid=?${binds.length})`);
}

// GET /api/explore?kind=&category=&country=&cursor=&limit=
export async function exploreBrowse(req: Request, env: Env): Promise<Response> {
  const uid = await maybeUid(req, env);
  const u = new URL(req.url).searchParams;
  const where = ["l.status IN ('published','live')"];
  const binds: unknown[] = [];
  for (const [k, col] of [["kind", "l.kind"], ["category", "l.category"], ["country", "l.country"]] as const) {
    const v = u.get(k);
    if (v) { binds.push(v); where.push(`${col}=?${binds.length}`); }
  }
  const creator = u.get("creator");
  if (creator) { binds.push(creator); where.push(`l.creator_id=?${binds.length}`); }
  blockFilter(uid, binds, where);
  const limit = Math.min(50, Math.max(1, Number(u.get("limit") || 20)));
  const offset = Math.max(0, Number(u.get("cursor") || 0));
  const rs = await metaSession(env).prepare(
    `${CARD_SELECT} WHERE ${where.join(" AND ")}
      ORDER BY (l.status='live') DESC, COALESCE(l.starts_at, 4102444800000) ASC, l.created_at DESC
      LIMIT ${limit + 1} OFFSET ${offset}`,
  ).bind(...binds).all();
  const rows = (rs.results ?? []) as any[];
  const page = rows.slice(0, limit);
  const promos = await promosFor(env, page.map((r) => r.id));
  trackImpressions(env, req, uid, APP, "explore", page.map((r) => String(r.id)));
  return json({ listings: page.map((r) => shapeCard(r, promos)), cursor: rows.length > limit ? String(offset + limit) : null });
}

// GET /api/explore/live-now — the red-dot rail.
export async function exploreLiveNow(req: Request, env: Env): Promise<Response> {
  const uid = await maybeUid(req, env);
  const where = ["l.status='live'"];
  const binds: unknown[] = [];
  blockFilter(uid, binds, where);
  const rs = await metaSession(env).prepare(
    `${CARD_SELECT} WHERE ${where.join(" AND ")} ORDER BY l.joined_count DESC LIMIT 25`,
  ).bind(...binds).all();
  const rows = (rs.results ?? []) as any[];
  const promos = await promosFor(env, rows.map((r) => r.id));
  trackImpressions(env, req, uid, APP, "live_now", rows.map((r) => String(r.id)));
  return json({ listings: rows.map((r) => ({ ...shapeCard(r, promos), joinable: true })) });
}

// GET /api/explore/search — A1: FTS5 + filters + sorts; partial title AND creator name hit.
export async function exploreSearch(req: Request, env: Env): Promise<Response> {
  const uid = await maybeUid(req, env);
  const u = new URL(req.url).searchParams;
  const q = (u.get("q") || "").trim();
  const where = ["l.status IN ('published','live')"];
  const binds: unknown[] = [];

  if (q) {
    const tokens = q.toLowerCase().replace(/[^a-z0-9\s@_-]/g, " ").split(/\s+/).filter(Boolean).slice(0, 6);
    if (tokens.length) {
      const match = tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(" ");
      const ids = await metaSession(env).prepare(
        "SELECT listing_id FROM listings_fts WHERE listings_fts MATCH ?1 LIMIT 200",
      ).bind(match).all();
      const idList = ((ids.results ?? []) as any[]).map((r) => String(r.listing_id));
      if (!idList.length) return json({ listings: [], cursor: null });
      where.push(`l.id IN (${idList.map((_, i) => `?${binds.length + i + 1}`).join(",")})`);
      binds.push(...idList);
    }
  }
  for (const [k, col] of [["kind", "l.kind"], ["category", "l.category"], ["country", "l.country"]] as const) {
    const v = u.get(k);
    if (v) { binds.push(v); where.push(`${col}=?${binds.length}`); }
  }
  const minPrice = Number(u.get("minPrice") || -1), maxPrice = Number(u.get("maxPrice") || -1);
  if (minPrice >= 0) { binds.push(minPrice); where.push(`l.price >= ?${binds.length}`); }
  if (maxPrice >= 0) { binds.push(maxPrice); where.push(`l.price <= ?${binds.length}`); }
  const from = Number(u.get("from") || 0), to = Number(u.get("to") || 0);
  if (from > 0) { binds.push(from); where.push(`l.starts_at >= ?${binds.length}`); }
  if (to > 0) { binds.push(to); where.push(`l.starts_at <= ?${binds.length}`); }
  const minRating = Number(u.get("minRating") || 0);
  if (minRating > 0) { binds.push(minRating); where.push(`l.rating_avg >= ?${binds.length}`); }
  blockFilter(uid, binds, where);

  const sort = u.get("sort") || "soonest";
  const order = sort === "cheapest" ? "l.price ASC"
    : sort === "popular" ? "l.joined_count DESC"
    : sort === "rating" ? "COALESCE(l.rating_avg,0) DESC, l.rating_count DESC"
    : "COALESCE(l.starts_at, 4102444800000) ASC";
  const limit = Math.min(50, Math.max(1, Number(u.get("limit") || 20)));
  const offset = Math.max(0, Number(u.get("cursor") || 0));
  const rs = await metaSession(env).prepare(
    `${CARD_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order}, l.created_at DESC LIMIT ${limit + 1} OFFSET ${offset}`,
  ).bind(...binds).all();
  const rows = (rs.results ?? []) as any[];
  const page = rows.slice(0, limit);
  const promos = await promosFor(env, page.map((r) => r.id));
  const g = geoOf(req);
  track(env, uid ?? "guest", "explore_search", APP, { q: q.slice(0, 40), sort, n: page.length, guest: !uid, country: g.country, city: g.city });
  trackImpressions(env, req, uid, APP, "search", page.map((r) => String(r.id)));
  return json({ listings: page.map((r) => shapeCard(r, promos)), cursor: rows.length > limit ? String(offset + limit) : null });
}

// GET /api/listings/:id — full details + creator card + reviews page 1.
export async function getListing(req: Request, env: Env, id: string): Promise<Response> {
  const uid = await maybeUid(req, env);
  const r = await metaSession(env).prepare(`${CARD_SELECT} WHERE l.id=?1`).bind(id).first<any>();
  if (!r) return json({ error: "not found" }, 404);
  const isOwner = uid === r.creator_id;
  if (r.status === "draft" && !isOwner) return json({ error: "not found" }, 404);
  const promos = await promosFor(env, [id]);
  const card = shapeCard(r, promos);
  const reviews = await metaSession(env).prepare(
    `SELECT rv.id, rv.author_id, rv.rating, rv.body, rv.reply, rv.reply_at, rv.created_at, u.display_name AS author_name, u.avatar_url AS author_avatar
       FROM reviews rv LEFT JOIN users u ON u.uid=rv.author_id WHERE rv.listing_id=?1 ORDER BY rv.created_at DESC LIMIT 20`,
  ).bind(id).all();
  const prof = await metaSession(env).prepare(
    "SELECT rating_avg, rating_count, follower_count FROM creator_profiles WHERE user_id=?1",
  ).bind(r.creator_id).first<any>();
  let following = false, booked = false;
  if (uid) {
    following = !!(await metaDb(env).prepare("SELECT 1 FROM creator_follows WHERE follower_id=?1 AND creator_id=?2").bind(uid, r.creator_id).first());
    booked = !!(await metaDb(env).prepare("SELECT 1 FROM bookings WHERE listing_id=?1 AND buyer_id=?2 AND status IN ('confirmed','completed')").bind(id, uid).first());
  }
  // Creator analytics: log non-owner detail views (D1 dashboard + PostHog mirror).
  if (!isOwner && ["published", "live"].includes(String(r.status))) {
    const src = new URL(req.url).searchParams.get("src");
    await recordView(env, req, {
      kind: "listing", subjectId: id, creatorId: String(r.creator_id), viewerUid: uid,
      app: APP, source: src, extra: { listing_kind: r.kind, price: Number(r.price), live: r.status === "live" },
    });
  }
  return json({
    listing: { ...card, description: r.description ?? "" },
    creator_stats: { rating_avg: prof?.rating_avg ?? null, rating_count: prof?.rating_count ?? 0, follower_count: prof?.follower_count ?? 0 },
    reviews: reviews.results ?? [],
    viewer: { following, booked, is_owner: isOwner },
  });
}

// GET /api/creators/:id — channel: profile, public fields, listings, reviews.
export async function getCreator(req: Request, env: Env, id: string): Promise<Response> {
  const uid = await maybeUid(req, env);
  const user = await metaSession(env).prepare(
    "SELECT uid, handle, display_name, bio, avatar_url FROM users WHERE uid=?1",
  ).bind(id).first<any>();
  if (!user) return json({ error: "not found" }, 404);
  const prof = await metaSession(env).prepare("SELECT * FROM creator_profiles WHERE user_id=?1").bind(id).first<any>();
  const kyc = await metaSession(env).prepare("SELECT status FROM kyc_status WHERE uid=?1").bind(id).first<any>();
  const ls = await metaSession(env).prepare(
    `${CARD_SELECT} WHERE l.creator_id=?1 AND l.status IN ('published','live')
      ORDER BY (l.status='live') DESC, COALESCE(l.starts_at, 4102444800000) ASC LIMIT 50`,
  ).bind(id).all();
  const lrows = (ls.results ?? []) as any[];
  const promos = await promosFor(env, lrows.map((r) => r.id));
  const reviews = await metaSession(env).prepare(
    `SELECT rv.id, rv.listing_id, rv.author_id, rv.rating, rv.body, rv.reply, rv.reply_at, rv.created_at, u.display_name AS author_name, u.avatar_url AS author_avatar
       FROM reviews rv LEFT JOIN users u ON u.uid=rv.author_id WHERE rv.creator_id=?1 ORDER BY rv.created_at DESC LIMIT 50`,
  ).bind(id).all();
  let following = false, notify = true;
  if (uid) {
    const f = await metaDb(env).prepare("SELECT notify FROM creator_follows WHERE follower_id=?1 AND creator_id=?2").bind(uid, id).first<any>();
    following = !!f; notify = f ? !!f.notify : true;
  }
  if (uid !== id) {
    const g = geoOf(req);
    track(env, uid ?? "guest", "creator_channel_viewed", APP, { creator_id: id, guest: !uid, country: g.country, city: g.city });
  }
  return json({
    creator: {
      uid: user.uid, handle: user.handle, name: user.display_name, avatar_url: user.avatar_url,
      bio: prof?.bio ?? user.bio ?? null,
      kyc_verified: kyc?.status === "verified",
      public_fields: parseJson(prof?.public_fields, {} as Record<string, unknown>),
      rating_avg: prof?.rating_avg ?? null, rating_count: prof?.rating_count ?? 0,
      follower_count: prof?.follower_count ?? 0,
      banner_r2_key: prof?.banner_r2_key ?? null,                       // A7
      links: parseJson(prof?.links, [] as unknown[]),
      intro_video_ref: prof?.intro_video_ref ?? null,
      pinned_listing_id: prof?.pinned_listing_id ?? null,
    },
    listings: lrows.map((r) => shapeCard(r, promos)),
    reviews: reviews.results ?? [],
    viewer: { following, notify },
  });
}

// PUT /api/creators/me — A7 channel editor (extras only; identity stays in users).
export async function updateMyChannel(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  let links: string | null | undefined = undefined;
  if (b.links !== undefined) {
    const arr = Array.isArray(b.links) ? b.links.slice(0, 8) : [];
    for (const li of arr) {
      if (!/^https:\/\//.test(String(li?.url || ""))) return json({ error: "links must be https" }, 400);
    }
    links = arr.length ? JSON.stringify(arr.map((li: any) => ({ label: String(li.label || "").slice(0, 40), url: String(li.url).slice(0, 300) }))) : null;
  }
  if (b.pinned_listing_id) {
    const own = await metaDb(env).prepare("SELECT creator_id FROM listings WHERE id=?1").bind(String(b.pinned_listing_id)).first<any>();
    if (!own || own.creator_id !== ctx.uid) return json({ error: "pinned listing not yours" }, 400);
  }
  const now = Date.now();
  await metaDb(env).prepare(
    `INSERT INTO creator_profiles (user_id, bio, public_fields, banner_r2_key, links, intro_video_ref, pinned_listing_id, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
     ON CONFLICT(user_id) DO UPDATE SET
       bio=COALESCE(?2,bio), public_fields=COALESCE(?3,public_fields), banner_r2_key=COALESCE(?4,banner_r2_key),
       links=COALESCE(?5,links), intro_video_ref=COALESCE(?6,intro_video_ref),
       pinned_listing_id=COALESCE(?7,pinned_listing_id), updated_at=?8`,
  ).bind(ctx.uid, b.bio !== undefined ? String(b.bio).slice(0, 2000) : null,
    b.public_fields !== undefined ? JSON.stringify(b.public_fields) : null,
    b.banner_r2_key !== undefined ? String(b.banner_r2_key) : null,
    links === undefined ? null : links,
    b.intro_video_ref !== undefined ? String(b.intro_video_ref) : null,
    b.pinned_listing_id ? String(b.pinned_listing_id) : null, now).run();
  track(env, ctx.uid, "channel_updated", APP, {});
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// A2 follows + A4 block + report
// ---------------------------------------------------------------------------

export async function followCreator(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (ctx.uid === id) return json({ error: "cannot follow yourself" }, 400);
  const b = (await req.json().catch(() => ({}))) as any;
  const db = metaDb(env);
  const exists = await db.prepare("SELECT notify FROM creator_follows WHERE follower_id=?1 AND creator_id=?2").bind(ctx.uid, id).first<any>();
  const notify = b.notify === undefined ? (exists ? !!exists.notify : true) : !!b.notify;
  if (exists) {
    // Per-creator mute toggle (notify=0) rides the same endpoint.
    await db.prepare("UPDATE creator_follows SET notify=?3 WHERE follower_id=?1 AND creator_id=?2").bind(ctx.uid, id, notify ? 1 : 0).run();
    return json({ ok: true, following: true, notify });
  }
  await db.batch([
    db.prepare("INSERT INTO creator_follows (follower_id, creator_id, created_at, notify) VALUES (?1,?2,?3,?4)").bind(ctx.uid, id, Date.now(), notify ? 1 : 0),
    db.prepare(`INSERT INTO creator_profiles (user_id, follower_count, updated_at) VALUES (?1,1,?2)
                ON CONFLICT(user_id) DO UPDATE SET follower_count=follower_count+1, updated_at=?2`).bind(id, Date.now()),
  ]);
  brainFact(env, ctx.uid, "creator_followed", APP, { creator: id });
  track(env, ctx.uid, "creator_followed", APP, {});
  return json({ ok: true, following: true, notify });
}

export async function unfollowCreator(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const db = metaDb(env);
  const r = await db.prepare("DELETE FROM creator_follows WHERE follower_id=?1 AND creator_id=?2").bind(ctx.uid, id).run();
  if ((r.meta?.changes ?? 0) > 0) {
    await db.prepare("UPDATE creator_profiles SET follower_count=MAX(0,follower_count-1), updated_at=?2 WHERE user_id=?1").bind(id, Date.now()).run();
  }
  track(env, ctx.uid, "creator_unfollowed", APP, {});
  return json({ ok: true, following: false });
}

// A4 buyer-side block: hides the creator's listings + blocks messages both ways
// (messaging honours the same `blocks` table via authz.blocks()).
export async function blockCreator(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (req.method === "DELETE") {
    await metaDb(env).prepare("DELETE FROM blocks WHERE uid=?1 AND blocked_npub=?2").bind(ctx.uid, id).run();
    return json({ ok: true, blocked: false });
  }
  await metaDb(env).prepare("INSERT OR IGNORE INTO blocks (uid, blocked_npub, created_at) VALUES (?1,?2,?3)").bind(ctx.uid, id, Date.now()).run();
  // Blocking also unfollows.
  await metaDb(env).prepare("DELETE FROM creator_follows WHERE follower_id=?1 AND creator_id=?2").bind(ctx.uid, id).run();
  track(env, ctx.uid, "creator_blocked", APP, {});
  return json({ ok: true, blocked: true });
}

// POST /api/report {targetType: listing|creator|review, targetId, reason} → user_reports.
export async function report(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const targetType = String(b.targetType || "");
  const targetId = String(b.targetId || "");
  if (!["listing", "creator", "review"].includes(targetType) || !targetId) {
    return json({ error: "targetType (listing|creator|review) and targetId required" }, 400);
  }
  let reportedUid = targetId;
  if (targetType === "listing") {
    const l = await metaDb(env).prepare("SELECT creator_id FROM listings WHERE id=?1").bind(targetId).first<any>();
    if (!l) return json({ error: "listing not found" }, 404);
    reportedUid = l.creator_id;
  } else if (targetType === "review") {
    const rv = await metaDb(env).prepare("SELECT author_id FROM reviews WHERE id=?1").bind(targetId).first<any>();
    if (!rv) return json({ error: "review not found" }, 404);
    reportedUid = rv.author_id;
  }
  await moderationDb(env).prepare(
    `INSERT INTO user_reports (id, reporter_npub, reported_npub, content_kind, content_id, category, description, status, priority, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,'open',3,?8)`,
  ).bind(crypto.randomUUID(), ctx.uid, reportedUid, targetType, targetId,
    String(b.reason || "other").slice(0, 60), b.description ? String(b.description).slice(0, 2000) : null, Date.now()).run();
  track(env, ctx.uid, "report_filed", APP, { targetType });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// purchase glue (full lifecycle in Phase 7)
// ---------------------------------------------------------------------------

// POST /api/listings/:id/book { slot?: {start_at,end_at}, promo_code? }
// Shared by "Book" and the live "Join & pay" popup. Creates orders row +
// booking + wallet escrow hold + joined_count bump + Brevo confirmation.
export async function bookListing(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const db = metaDb(env);
  const l = await db.prepare("SELECT * FROM listings WHERE id=?1").bind(id).first<any>();
  if (!l || !["published", "live"].includes(l.status)) return json({ error: "listing not available" }, 404);
  if (l.creator_id === ctx.uid) return json({ error: "cannot book your own listing" }, 400);
  // Phase 7 A5 — creator block list: a blocked buyer cannot book this creator.
  {
    const blocked = await db.prepare("SELECT 1 FROM blocks WHERE uid=?1 AND blocked_npub=?2").bind(l.creator_id, ctx.uid).first().catch(() => null);
    if (blocked) return json({ error: "listing not available" }, 404);
  }

  // Window: live events are fixed; consults bring a slot from the picker.
  let start: number, end: number;
  if (l.kind === "live_event") {
    start = Number(l.starts_at);
    end = start + Number(l.duration_min || 60) * 60_000;
    if (l.status !== "live" && start < Date.now()) return json({ error: "event already started" }, 409);
  } else {
    start = Math.trunc(Number(b.slot?.start_at));
    end = Math.trunc(Number(b.slot?.end_at || (start + Number(l.duration_min || 60) * 60_000)));
    if (!(start > Date.now()) || !(end > start)) return json({ error: "slot {start_at, end_at} required (future)" }, 400);
    // Server-side policy re-validation (UI greying is not enforcement).
    const viol = await policyViolation(env, l.creator_id, start, end);
    if (viol) return json({ error: "policy", reason: viol }, 409);
    // Capacity: seats on this exact window.
    const seats = await db.prepare(
      "SELECT COUNT(*) AS n FROM bookings WHERE listing_id=?1 AND starts_at=?2 AND status IN ('confirmed','completed')",
    ).bind(id, start).first<{ n: number }>();
    if ((seats?.n ?? 0) >= Number(l.capacity || 1)) return json({ error: "slot full" }, 409);
  }

  // A5: best single promotion (early-bird auto; promo code when provided).
  const promos = await promosFor(env, [id]);
  const { pct, promo } = activePromoPct(promos.get(id) ?? [], Date.now(), b.promo_code ?? null);
  const amount = pct > 0 ? Math.round(Number(l.price) * (100 - pct) / 100) : Number(l.price);

  const bookingId = crypto.randomUUID();
  const orderId = `ord_${bookingId.slice(0, 18)}`;

  // Voice translation add-on ("Would you like this to be translated into the
  // language of your choice?"). $3/h = 5 AvaCoins/min for the booked duration;
  // 100% platform fee — NEVER shared with the creator. Unused minutes refund
  // at settlement.
  let trlLang: string | null = null, trlCoins = 0, trlOrderId: string | null = null;
  if (b.translation?.lang) {
    if (!l.translation_enabled) return json({ error: "translation not offered on this listing" }, 400);
    const lang = String(b.translation.lang);
    if (!TRL_LANGS.has(lang)) return json({ error: "unsupported translation language", lang }, 400);
    trlLang = lang;
    trlCoins = Math.ceil((end - start) / 60_000) * TRL_RATE;
    trlOrderId = `trl_${bookingId.slice(0, 18)}`;
  }

  // Conflict engine claims: the BUYER always; the creator too for 1:1 consults.
  const claim = await claimBlock(env, { userId: ctx.uid, sourceApp: "avabooking", sourceRef: bookingId, start, end, title: String(l.title) });
  if (!claim.ok) return json({ error: "conflict", conflictWith: claim.conflict }, 409);
  let creatorClaimed = false;
  if (l.kind === "consult" && Number(l.capacity || 1) === 1) {
    const cc = await claimBlock(env, { userId: l.creator_id, sourceApp: APP, sourceRef: bookingId, start, end, title: String(l.title) });
    if (!cc.ok) {
      await releaseBlocks(env, "avabooking", bookingId);
      return json({ error: "conflict", conflictWith: cc.conflict }, 409);
    }
    creatorClaimed = true;
  }

  // Money: escrow hold (Phase 2). Free listings skip the wallet entirely (A5).
  if (amount > 0) {
    const h = await hold(env, ctx.uid, orderId, amount, { title: String(l.title), app: APP });
    if (!h.ok) {
      await releaseBlocks(env, "avabooking", bookingId);
      if (creatorClaimed) await releaseBlocks(env, APP, bookingId);
      if (h.status === 402) return json({ error: "insufficient_funds", needed: amount + trlCoins, ...h.body }, 402);
      return json({ error: "payment failed", detail: h.body }, 502);
    }
  }
  // Translation prepay → its own escrow bucket (trl_*). On failure, unwind the
  // main hold so the buyer never pays for a booking they didn't get.
  if (trlOrderId && trlCoins > 0) {
    const th = await hold(env, ctx.uid, trlOrderId, trlCoins, { title: `Voice translation (${trlLang})`, app: "avatranslate" });
    if (!th.ok) {
      if (amount > 0) await refund(env, orderId, ctx.uid, amount, { opId: `refund:${orderId}:trlfail`, reason: "booking failed (translation payment)", title: String(l.title) });
      await releaseBlocks(env, "avabooking", bookingId);
      if (creatorClaimed) await releaseBlocks(env, APP, bookingId);
      if (th.status === 402) return json({ error: "insufficient_funds", needed: amount + trlCoins, ...th.body }, 402);
      return json({ error: "payment failed", detail: th.body }, 502);
    }
  }

  const now = Date.now();
  const bkKind = l.kind === "live_event" ? "live_event" : (Number(l.capacity || 1) > 1 ? "consult_group" : "consult_1to1");
  const mkEvent = (owner: string, role: string) => db.prepare(
    `INSERT INTO calendar_events (id, booking_id, slot_id, owner_npub, owner_uid, role, host_npub, host_uid, attendee_npub, attendee_uid, title, start_at, end_at, price_coins, paid, status, source, created_at)
     VALUES (?1,?2,?3,?4,?4,?5,?6,?6,?7,?7,?8,?9,?10,?11,?12,'confirmed','user',?13)`,
  ).bind(crypto.randomUUID(), bookingId, id, owner, role, l.creator_id, ctx.uid, l.title, start, end, amount, amount > 0 ? 1 : 0, now);
  await db.batch([
    db.prepare(
      `INSERT INTO orders (id, listing_id, buyer_id, creator_id, amount, promo_id, status, created_at, updated_at, kind, fee_pct, escrow_account, booking_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8,?9,20,?10,?11)`,
    ).bind(orderId, id, ctx.uid, l.creator_id, amount, promo?.id ?? null, amount > 0 ? "held" : "free", now,
      l.kind === "live_event" ? "live_event" : "consult", `escrow:${orderId}`, bookingId),
    db.prepare(
      `INSERT INTO bookings (id, creator_id, buyer_id, listing_id, kind, starts_at, ends_at, price, order_id, status, translation_lang, translation_coins, trl_order_id, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'confirmed',?10,?11,?12,?13,?13)`,
    ).bind(bookingId, l.creator_id, ctx.uid, id, bkKind, start, end, amount, amount > 0 ? orderId : null, trlLang, trlCoins, trlOrderId, now),
    mkEvent(ctx.uid, "attendee"),
    mkEvent(l.creator_id, "host"),
    db.prepare("UPDATE listings SET joined_count=joined_count+1, updated_at=?2 WHERE id=?1").bind(id, now),
    ...(promo ? [db.prepare("UPDATE listing_promotions SET used=used+1 WHERE id=?1").bind(promo.id)] : []),
  ]);

  // Phase 7: arm the session DO — alarms at start+wait (no-show check) and
  // end+grace (settlement) fire the refund engine exactly on time. The minute
  // sweep is the safety net, so best-effort here.
  try {
    const sid = l.kind === "live_event" ? id : bookingId;
    const doKey = l.kind === "live_event" ? `live:${id}` : `consult:${bookingId}`;
    await env.STREAM_SESSION_DO.get(env.STREAM_SESSION_DO.idFromName(doKey)).fetch("https://session/op", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "schedule", sid, kind: l.kind === "live_event" ? "live_event" : "consult", starts_at: start, ends_at: end, host_id: l.creator_id }),
    });
  } catch { /* sweep covers it */ }

  // Confirmation email (date/time + how to join) + push, both sides. Best-effort.
  const [creatorName, buyerName] = await Promise.all([nameOf(env, l.creator_id), nameOf(env, ctx.uid)]);
  try {
    await emailBookingConfirmed(env, { bookingId, title: l.title, start, end, price: amount, creatorId: l.creator_id, buyerId: ctx.uid, creatorName, buyerName });
  } catch { /* best-effort */ }
  try { await notifyUser(env, l.creator_id, { type: "system", title: l.kind === "live_event" ? "New attendee" : "New booking", body: l.title, data: { deeplink: "/booking", booking_id: bookingId } }); } catch { /* best-effort */ }
  try { await notifyUser(env, ctx.uid, { type: "system", title: "Booking confirmed", body: l.title, data: { deeplink: `/explore/listing/${id}`, booking_id: bookingId } }); } catch { /* best-effort */ }
  brainFact(env, ctx.uid, "listing_booked", APP, { title: l.title, kind: l.kind, amount });
  {
    const g = geoOf(req);
    track(env, ctx.uid, "listing_booked", APP, {
      kind: l.kind, amount, promo: pct, live: l.status === "live", translation: !!trlLang,
      listing_id: id, creator_id: l.creator_id, country: g.country, city: g.city, region: g.region,
    });
  }
  return json({
    ok: true, booking_id: bookingId, order_id: orderId, amount, paid: amount + trlCoins > 0,
    translation: trlLang ? { lang: trlLang, coins: trlCoins, order_id: trlOrderId } : null,
    total: amount + trlCoins,
    start_at: start, end_at: end, joinable: l.status === "live",
  });
}

// POST /api/listings/:id/reviews { rating 1–5, body? } — attendees only.
export async function createReview(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const rating = Math.trunc(Number(b.rating));
  if (!(rating >= 1 && rating <= 5)) return json({ error: "rating 1–5 required" }, 400);
  const db = metaDb(env);
  const l = await db.prepare("SELECT creator_id, status FROM listings WHERE id=?1").bind(id).first<any>();
  if (!l) return json({ error: "not found" }, 404);
  if (l.creator_id === ctx.uid) return json({ error: "cannot review your own listing" }, 400);

  // Attendance gate: a confirmed/completed booking whose window has passed.
  const bk = await db.prepare(
    "SELECT 1 FROM bookings WHERE listing_id=?1 AND buyer_id=?2 AND status IN ('confirmed','completed') AND ends_at <= ?3",
  ).bind(id, ctx.uid, Date.now()).first();
  if (!bk) return json({ error: "only attendees can review (after the session ends)" }, 403);

  const now = Date.now();
  await db.prepare(
    `INSERT INTO reviews (id, listing_id, creator_id, author_id, rating, body, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7)
     ON CONFLICT(listing_id, author_id) DO UPDATE SET rating=?5, body=?6, created_at=?7`,
  ).bind(crypto.randomUUID(), id, l.creator_id, ctx.uid, rating, b.body ? String(b.body).slice(0, 2000) : null, now).run();

  // Averages update on the card AND the channel (acceptance criterion).
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
  try { await notifyUser(env, l.creator_id, { type: "social", title: `New ${rating}★ review`, body: b.body ? String(b.body).slice(0, 80) : undefined, data: { deeplink: `/explore/listing/${id}` } }); } catch { /* best-effort */ }
  brainFact(env, ctx.uid, "review_left", APP, { rating });
  track(env, ctx.uid, "review_created", APP, { rating });
  return json({ ok: true });
}
