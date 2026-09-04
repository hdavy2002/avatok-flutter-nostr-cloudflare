import type { Env } from "../types";
import { json } from "../util";
import { requireAdmin } from "./admin_money";
import { track } from "../hooks";
import { generateListingPoster, type PosterState } from "../lib/listing_poster";

// Admin-only moderation queue. Poster metadata is kept in listings.attrs so this
// remains compatible with the existing schema and does not alter creator data.
export async function adminListings(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const status = new URL(req.url).searchParams.get("status") || "all";
  const where = status === "all" ? "" : "WHERE l.status=?1";
  const q = await env.DB_META.prepare(`SELECT l.id,l.title,l.description,l.kind,l.status,l.price,l.cover_media,l.attrs,l.created_at,l.updated_at,l.creator_id FROM listings l ${where} ORDER BY l.updated_at DESC LIMIT 100`).bind(...(status === "all" ? [] : [status])).all<any>();
  return json({ listings: q.results ?? [], statuses: ["draft", "pending_review", "published", "rejected"] });
}

function safeParse<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw !== "string") return raw as T;
  try {
    const v = JSON.parse(raw);
    return (v ?? fallback) as T;
  } catch { return fallback; }
}

// Best-effort telemetry — a track() failure must never fail a moderation action
// or a detail-view read. See hooks.ts:track — it takes (env, uid, event,
// app_name, props, trace_id?); a 3-arg call silently corrupts the payload.
function safeTrack(env: Env, uid: string, event: string, props: Record<string, unknown>): void {
  try { void track(env, uid, event, "admin_listings", props); } catch { /* best-effort */ }
}

// GET /api/admin/listings/:id — full review detail. UI contract: do not
// rename any top-level key without updating the client that reads it.
export async function adminListingDetail(req: Request, env: Env, id: string): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const db = env.DB_META;
  const row = await db.prepare("SELECT l.* FROM listings l WHERE l.id=?1").bind(id).first<any>();
  if (!row) return json({ error: "not found" }, 404);

  const attrsRaw: Record<string, any> = safeParse(row.attrs, {} as Record<string, any>);
  // Admin sees everything the creator submitted except the private transport
  // key used to stage cover_media between the generate step and the DB write.
  const attrs: Record<string, any> = { ...attrsRaw };
  delete attrs.__generated_cover_media;

  const listing: Record<string, any> = { ...row };
  listing.attrs = attrs;
  listing.cover_media = safeParse(row.cover_media, [] as any[]);
  listing.badges = safeParse(row.badges, null as any[] | null);
  listing.vibe_tags = safeParse(row.vibe_tags, null as any[] | null);
  listing.recurrence_days = safeParse(row.recurrence_days, null as any[] | null);
  listing.spoken_lang = safeParse(row.spoken_lang, null as any[] | null);

  // Creator — identity lives in `users` (DB_META, cfnative.sql); channel extras
  // in `creator_profiles` (DB_META, listings.sql); KYC gate in `kyc_status`
  // (DB_META, cfnative.sql). Never surface phone_hash/email_hash raw values —
  // those are sha256 already and are not "the real phone number", but they are
  // also not a display field, so they are simply not selected here.
  const creatorId: string | null = row.creator_id ?? null;
  let creator: { id: string | null; handle: string | null; display_name: string | null; avatar_url: string | null; kyc_status: string | null } = {
    id: creatorId, handle: null, display_name: null, avatar_url: null, kyc_status: null,
  };
  if (creatorId) {
    const u = await db.prepare("SELECT handle,display_name,avatar_url FROM users WHERE uid=?1").bind(creatorId).first<any>();
    const k = await db.prepare("SELECT status FROM kyc_status WHERE uid=?1").bind(creatorId).first<{ status: string }>();
    creator = {
      id: creatorId,
      handle: u?.handle ?? null,
      display_name: u?.display_name ?? null,
      avatar_url: u?.avatar_url ?? null,
      kyc_status: k?.status ?? null,
    };
  }

  const poster = attrs.poster ?? null;

  const historyRs = await db.prepare(
    `SELECT id, actor_id, action, previous_status, next_status, reason, poster_status, created_at
     FROM listing_approval_history WHERE listing_id=?1 ORDER BY created_at DESC LIMIT 50`,
  ).bind(id).all<any>();
  const history = historyRs.results ?? [];

  let category: { id: string; label: string; vertical: string | null; intent: string | null } | null = null;
  if (row.category) {
    const c = await db.prepare("SELECT id,label,vertical,intent FROM listing_categories WHERE id=?1").bind(row.category).first<any>();
    if (c) category = { id: c.id, label: c.label, vertical: c.vertical ?? null, intent: c.intent ?? null };
  }

  const slotsRs = await db.prepare(
    "SELECT * FROM listing_slots WHERE listing_id=?1 ORDER BY starts_at ASC",
  ).bind(id).all<any>().catch(() => ({ results: [] }) as any);
  const slots = slotsRs.results ?? [];

  safeTrack(env, a.uid, "admin_listing_detail_view", {
    listing_id: id,
    status: row.status ?? null,
    poster_status: poster?.status ?? null,
    admin_id: a.uid,
  });

  return json({ listing, creator, poster, history, category, slots });
}

function writeListingApprovalHistory(
  env: Env,
  args: {
    listingId: string;
    actorId: string;
    action: string;
    previousStatus: string | null;
    nextStatus: string | null;
    reason?: string | null;
    posterStatus?: string | null;
  },
): D1PreparedStatement {
  return env.DB_META.prepare(
    `INSERT INTO listing_approval_history
     (id, listing_id, actor_id, action, previous_status, next_status, reason, poster_status, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
  ).bind(
    crypto.randomUUID(),
    args.listingId,
    args.actorId,
    args.action,
    args.previousStatus,
    args.nextStatus,
    args.reason ?? null,
    args.posterStatus ?? null,
    Date.now(),
  );
}

function approvalRequired(listing: { id: string; status: string; poster_status?: string | null; approval_status?: string | null }): Response {
  return json({
    approved: false,
    code: "approval_required",
    reason: "approval_required",
    listing_id: listing.id,
    status: listing.status,
    approval_status: listing.approval_status ?? listing.status,
    poster_status: listing.poster_status ?? null,
    message: "Listing approval is required before publish.",
  }, 409);
}

const ALLOWED_ACTIONS = ["approve_listing", "reject_listing", "generate_poster", "regenerate_poster", "approve_poster", "reject_poster", "publish"];

export async function adminListingAction(req: Request, env: Env, id: string): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const body = await req.json().catch(() => ({})) as any;
  const action = String(body.action || "");
  const db = env.DB_META;
  const row = await db.prepare("SELECT * FROM listings WHERE id=?1").bind(id).first<any>();
  if (!row) return json({ error: "not found" }, 404);
  const now = Date.now();
  if (!ALLOWED_ACTIONS.includes(action)) return json({ error: "invalid action" }, 400);
  let attrs: any = {}; try { attrs = row.attrs ? JSON.parse(row.attrs) : {}; } catch { attrs = {}; }

  if (action === "generate_poster" || action === "regenerate_poster") {
    const priorStatus: string | undefined = attrs.poster?.status;
    if (action === "regenerate_poster") {
      // Owner decision: regenerate is latest-only, no variant history. It is
      // allowed to replace a draft/rejected/failed poster, but never a poster
      // that is already approved (that would be a silent moderation hole) and
      // never one mid-flight.
      if (priorStatus === "approved") return json({ error: "poster already approved; cannot regenerate", code: "poster_approved" }, 409);
      if (priorStatus === "generating") return json({ error: "poster generation already in progress", code: "poster_generating" }, 409);
    }
    const promptOverride = typeof body.prompt === "string" ? body.prompt.slice(0, 1800) : undefined;
    const prevAttempt = Number(attrs.poster?.attempt) || 0;
    const attempt = action === "regenerate_poster" ? prevAttempt + 1 : (prevAttempt || 1);
    attrs.poster = { ...(attrs.poster || {}), status: "generating", generated_at: now, attempt };
    await db.prepare("UPDATE listings SET attrs=?2, updated_at=?3 WHERE id=?1").bind(id, JSON.stringify(attrs), now).run();
    try {
      const result = await generateListingPoster(env, {
        listingId: id,
        ownerUid: String(row.creator_id || ""),
        row,
        prompt: promptOverride,
        actorUid: a.uid,
        auto: false,
        attempt,
      });
      attrs.poster = result.poster;
      if (Array.isArray(result.coverMedia)) {
        (attrs as any).__generated_cover_media = result.coverMedia;
      }
    } catch (e) {
      const prevPoster: PosterState | undefined = attrs.poster;
      attrs.poster = { ...(prevPoster || {}), status: "failed", attempt, error: String((e as any)?.message || "provider unavailable").slice(0, 180) };
    }
  } else if (action === "approve_poster") {
    if (!attrs.poster) return json({ error: "poster not generated" }, 409);
    attrs.poster.status = "approved";
  } else if (action === "reject_poster") {
    const reason = String(body.reason || body.feedback || "").trim();
    if (!reason) return json({ error: "reason required" }, 400);
    attrs.poster = { ...(attrs.poster || {}), status: "rejected", feedback: reason, rejected_reason: reason };
  }
  let next = row.status;
  if (action === "approve_listing") {
    if (!["draft", "pending_review"].includes(String(row.status))) return json({ error: "listing not awaiting approval", status: row.status }, 409);
    next = "approved";
  }
  if (action === "reject_listing") {
    const reason = String(body.reason || "").trim();
    if (!reason) return json({ error: "reason required" }, 400);
    next = "rejected";
  }
  if (action === "publish") {
    if (String(row.status) !== "approved") return approvalRequired({ id: row.id, status: row.status, approval_status: row.status, poster_status: attrs.poster?.status ?? null });
    if (attrs.poster?.status !== "approved") return json({ error: "poster approval required" }, 409);
    next = "published";
  }
  let coverMedia = row.cover_media ?? null;
  if (Array.isArray(attrs.__generated_cover_media)) {
    coverMedia = JSON.stringify(attrs.__generated_cover_media);
    delete attrs.__generated_cover_media;
  }
  const reasonForHistory = action === "publish"
    ? "published_by_admin"
    : (action === "reject_listing" ? String(body.reason || "").trim()
      : (action === "reject_poster" ? String(body.reason || body.feedback || "").trim() : null));
  const history = writeListingApprovalHistory(env, {
    listingId: id,
    actorId: a.uid,
    action,
    previousStatus: row.status,
    nextStatus: next,
    reason: reasonForHistory,
    posterStatus: attrs.poster?.status ?? null,
  });
  await db.batch([
    history,
    db.prepare("UPDATE listings SET status=?2, attrs=?3, cover_media=?4, updated_at=?5 WHERE id=?1").bind(id, next, JSON.stringify(attrs), coverMedia, now),
  ]);
  // Keep moderation actions visible in the existing admin audit stream.
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(crypto.randomUUID(), a.uid, `listing_${action}`, id, JSON.stringify({ previous_status: row.status, next_status: next, poster_status: attrs.poster?.status ?? null, reason: reasonForHistory || null }), now).run();
  } catch { /* audit is best-effort, matching existing admin routes */ }

  safeTrack(env, a.uid, "listing_moderation_action", {
    listing_id: id,
    action,
    previous_status: row.status ?? null,
    next_status: next ?? null,
    poster_status: attrs.poster?.status ?? null,
    admin_id: a.uid,
    creator_id: row.creator_id ?? null,
    reason_present: !!(reasonForHistory && reasonForHistory.length > 0),
  });

  return json({ ok: true, id, status: next, poster: attrs.poster || null, admin_id: a.uid, reason: reasonForHistory || null });
}
