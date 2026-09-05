import type { Env } from "../types";
import { json } from "../util";
import { requireAdmin } from "./admin_money";
import { track } from "../hooks";
import { generateListingPoster, type PosterState } from "../lib/listing_poster";
import { resolveCreatorSubject } from "../lib/poster_subject";
import { readConfig } from "./config";
// [C03 MKT-PUBLISH-UNIFY-1] The one authoritative publish path — see the doc
// comment on publishListingAuthoritative() in routes/listings.ts. `publish`
// below no longer does its own raw status UPDATE; it defers to the same
// function the creator's own publish endpoint calls.
import { publishListingAuthoritative, reviewedContentHash } from "./listings";
// [C01 MKT-STATUS-GATE-1] Same transition table setListingStatus()/publish use —
// see item 4: `reject_listing` used to flip ANY status straight to 'rejected'
// with no source-status guard at all.
import { checkTransition } from "../lib/listing_transitions";

// Admin-only moderation queue. Poster metadata is kept in listings.attrs so this
// remains compatible with the existing schema and does not alter creator data.
export async function adminListings(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const status = new URL(req.url).searchParams.get("status") || "all";
  const where = status === "all" ? "" : "WHERE l.status=?1";
  const q = await env.DB_META.prepare(`SELECT l.id,l.title,l.description,l.kind,l.status,l.price,l.cover_media,l.attrs,l.created_at,l.updated_at,l.creator_id FROM listings l ${where} ORDER BY l.updated_at DESC LIMIT 100`).bind(...(status === "all" ? [] : [status])).all<any>();
  return json({ listings: q.results ?? [], statuses: ["draft", "pending_review", "approved", "published", "live", "rejected"] });
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
  // Internal keys are server transport/state and never part of the review payload.
  const attrs: Record<string, any> = { ...attrsRaw };
  for (const key of Object.keys(attrs)) if (key.startsWith("__")) delete attrs[key];

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

// [ADMIN-QUEUE-TELEMETRY-1] web/src/islands/admin/* carries zero PostHog and
// there is no time-in-queue metric anywhere for the review pipeline. This reads
// the `next_status='pending_review'` row `submitListingForApproval()` writes
// (routes/listings.ts) so `queue_ms` on the publish event below is a real
// measurement, not a guess. Best-effort: a lookup failure must never block a
// publish, it just means that one event carries `queue_ms: null`.
async function queuedSinceMs(env: Env, listingId: string): Promise<number | null> {
  try {
    const row = await env.DB_META.prepare(
      `SELECT created_at FROM listing_approval_history
        WHERE listing_id=?1 AND next_status='pending_review'
        ORDER BY created_at DESC LIMIT 1`,
    ).bind(listingId).first<{ created_at: number }>();
    return row ? Number(row.created_at) : null;
  } catch { return null; }
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
  for (const key of Object.keys(attrs)) if (key.startsWith("__")) delete attrs[key];
  let generatedCoverMedia: any[] | null = null;

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
    const existingCovers = safeParse<any[]>(row.cover_media, [])
      .filter((c) => c && c.source !== "ai_poster");
    if (existingCovers.length >= 5) {
      return json({
        error: "cover_slot_required", code: "cover_slot_required", cover_count: existingCovers.length,
        message: "Remove one creator photo before generating the AI poster (maximum 5 covers).",
      }, 409);
    }
    const posterCfg = await readConfig(env);
    const promptOverride = typeof body.prompt === "string" ? body.prompt.slice(0, 1800) : undefined;
    const prevAttempt = Number(attrs.poster?.attempt) || 0;
    const attempt = action === "regenerate_poster" ? prevAttempt + 1 : (prevAttempt || 1);
    attrs.poster = { ...(attrs.poster || {}), status: "generating", generated_at: now, attempt };
    // [POSTER-SUBJECT-1 2026-09-05] Who the poster is of, from the creator's
    // profile. Resolved on the regenerate path too — an admin regenerating a
    // poster that came back with the wrong person, which is the very reason
    // they are clicking the button, must not get the same wrong person again.
    const subjectCfg = (posterCfg as any).posterCreatorSubjectEnabled === true;
    const subject = subjectCfg
      ? await resolveCreatorSubject(env, String(row.creator_id || ""), {
          usePhoto: (posterCfg as any).posterCreatorPhotoEnabled === true,
        })
      : null;
    try {
      const result = await generateListingPoster(env, {
        listingId: id,
        ownerUid: String(row.creator_id || ""),
        row,
        prompt: promptOverride,
        subject,
        // [POSTER-FILMY-1] Same on regenerate: an admin re-rolling a poster
        // should get a fresh punch line, not the same one back.
        dialogue: (posterCfg as any).posterDialogueEnabled === true,
        actorUid: a.uid,
        auto: false,
        attempt,
        // [POSTER-FIRST-1 2026-09-05] The admin regenerate path gets the SAME
        // flags as the auto path. Omitting them here would make "regenerate"
        // quietly produce an unverified, single-ratio poster that looks like
        // every other one — the hardest kind of inconsistency to notice, since
        // the difference is invisible until someone reads the lettering.
        variants: (posterCfg as any).posterVariantsEnabled === true,
        verify: (posterCfg as any).posterVerifyEnabled === true,
        composeFallback: (posterCfg as any).posterComposeFallbackEnabled === true,
        maxAttempts: Number((posterCfg as any).posterVerifyMaxAttempts ?? 3) || 3,
      });
      attrs.poster = result.poster;
      if (Array.isArray(result.coverMedia)) generatedCoverMedia = result.coverMedia;
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
  // [C03 MKT-PUBLISH-UNIFY-1] `publish` is handled ENTIRELY by
  // publishListingAuthoritative() — no raw status UPDATE here anymore. The two
  // admin-only pre-checks below (approved status, poster approved) stay: they are
  // ADDITIONAL gates specific to the moderation queue, not a replacement for
  // anything the shared publisher does. See the doc comment on
  // publishListingAuthoritative() in routes/listings.ts for the full list of
  // checks this now runs that the old bare UPDATE skipped.
  if (action === "publish") {
    if (String(row.status) !== "approved") return approvalRequired({ id: row.id, status: row.status, approval_status: row.status, poster_status: attrs.poster?.status ?? null });
    if (attrs.poster?.status !== "approved") return json({ error: "poster approval required" }, 409);

    const result = await publishListingAuthoritative(env, { listingId: id, actor: "admin", actorUid: a.uid });
    const nextStatus = String((result.body as any)?.status ?? row.status);
    const reasonForHistory = result.ok ? "published_by_admin" : String((result.body as any)?.error ?? "publish_failed");

    await writeListingApprovalHistory(env, {
      listingId: id,
      actorId: a.uid,
      action,
      previousStatus: row.status,
      nextStatus: result.ok ? nextStatus : row.status,
      reason: reasonForHistory,
      posterStatus: attrs.poster?.status ?? null,
    }).run();
    // Keep moderation actions visible in the existing admin audit stream.
    try {
      await env.DB_WALLET.prepare(
        "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
      ).bind(crypto.randomUUID(), a.uid, `listing_${action}`, id, JSON.stringify({
        previous_status: row.status, next_status: result.ok ? nextStatus : row.status,
        poster_status: attrs.poster?.status ?? null, reason: reasonForHistory, ok: result.ok,
      }), now).run();
    } catch { /* audit is best-effort, matching existing admin routes */ }

    // [ADMIN-QUEUE-TELEMETRY-1] `queue_ms` — how long this listing sat in the
    // review queue before an admin published it. See queuedSinceMs() above.
    const queuedAt = await queuedSinceMs(env, id);
    safeTrack(env, a.uid, "admin_listing_published", {
      listing_id: id,
      ok: result.ok,
      previous_status: row.status ?? null,
      next_status: result.ok ? nextStatus : row.status,
      poster_status: attrs.poster?.status ?? null,
      admin_id: a.uid,
      creator_id: row.creator_id ?? null,
      queue_ms: queuedAt != null ? now - queuedAt : null,
      fail_reason: result.ok ? null : (result.body as any)?.error ?? null,
    });

    if (!result.ok) return json(result.body, result.status);
    return json({ ok: true, id, status: nextStatus, poster: attrs.poster || null, admin_id: a.uid, reason: null, ...result.body });
  }

  let next = row.status;
  if (action === "approve_listing") {
    const legacyRebind = String(row.status) === "approved" && !row.reviewed_content_hash;
    if (!legacyRebind) {
      const check = checkTransition(String(row.status), "approved", "admin");
      if (!check.ok) {
        return json({ error: "transition_not_allowed", reason: check.reason, status_now: row.status, allowed_targets: check.allowedTargets }, 409);
      }
    }
    next = "approved";
  }
  if (action === "reject_listing") {
    const reason = String(body.reason || "").trim();
    if (!reason) return json({ error: "reason required" }, 400);
    // [C01/C03 admin-reject-guard] Previously this flipped ANY status straight to
    // 'rejected' with no source-status check at all — a terminal listing
    // (completed/cancelled) or an already-live one could be "rejected" with
    // nothing to stop the write. checkTransition() is the single authority on
    // (from, to, actor) legality everywhere else in this pipeline (see C01);
    // admin reject now obeys the same table instead of being a silent bypass.
    const check = checkTransition(String(row.status), "rejected", "admin");
    if (!check.ok) {
      safeTrack(env, a.uid, "listing_moderation_transition_refused", {
        listing_id: id, from: row.status, to: "rejected", reason: check.reason, action,
      });
      return json({ error: "transition_not_allowed", reason: check.reason, status_now: row.status, allowed_targets: check.allowedTargets }, 409);
    }
    next = "rejected";
  }
  let coverMedia = row.cover_media ?? null;
  if (Array.isArray(generatedCoverMedia)) {
    // [C03 cover-cap] Same 1-5 cover cap publishListingAuthoritative() enforces
    // for creators. lib/listing_poster.ts:132-136 PREPENDS the AI poster onto
    // cover_media with no cap of its own, so a poster generated on top of an
    // already-full gallery (5 uploads) produces 6 — which the creator's own
    // publish endpoint then rejects with "max 5 photos". Not fixed there — we do
    // not own lib/listing_poster.ts — but this write must not silently truncate
    // media a reviewer just approved (dropping one of their photos would be its
    // own kind of wrong): refuse the write and name the count so the reviewer
    // knows exactly why and can remove one before saving.
    if (generatedCoverMedia.length > 5) {
      return json({
        error: "max 5 photos", code: "cover_cap_exceeded",
        cover_count: generatedCoverMedia.length, limit: 5,
        message: `Poster generation produced ${generatedCoverMedia.length} cover images; the limit is 5. Remove one before saving.`,
      }, 400);
    }
    coverMedia = JSON.stringify(generatedCoverMedia);
  }
  const reasonForHistory = action === "reject_listing" ? String(body.reason || "").trim()
    : (action === "reject_poster" ? String(body.reason || body.feedback || "").trim() : null);

  // [LIST-REVIEW-BINDING-1] Second half of C02 — bind THIS approval to the content
  // it's approving, so a later creator rewrite of title/price/category/description/
  // photos can be detected and the stale approval invalidated (see the review-
  // binding block in updateListing, routes/listings.ts). Only `approve_listing` and
  // `reject_listing` touch these three columns; every other action here (poster
  // generate/approve/reject) leaves status — and therefore the review binding —
  // untouched, so those must carry the row's EXISTING values forward, not null them.
  let reviewedHash: string | null = row.reviewed_content_hash ?? null;
  let reviewedAt: number | null = row.reviewed_at ?? null;
  let reviewedBy: string | null = row.reviewed_by ?? null;
  if (action === "approve_listing") {
    // Hash the content as it will actually be WRITTEN below: `attrs`/`coverMedia`
    // already reflect this request's poster-generation cover-cap merge (if any),
    // and every other listing field is untouched by this action.
    reviewedHash = await reviewedContentHash({ ...row, attrs: JSON.stringify(attrs), cover_media: coverMedia });
    reviewedAt = now;
    reviewedBy = a.uid;
    safeTrack(env, a.uid, "listing_review_binding_recorded", {
      listing_id: id, admin_id: a.uid, creator_id: row.creator_id ?? null,
      previous_status: row.status ?? null, hash_prefix: reviewedHash.slice(0, 12),
    });
  } else if (action === "reject_listing") {
    // Rejected content is no longer approved by definition — clear the binding so
    // a future re-approval (via draft -> pending_review -> approve_listing) always
    // earns a fresh hash rather than carrying a stale one forward.
    reviewedHash = null;
    reviewedAt = null;
    reviewedBy = null;
  }

  const updated = await db.prepare(
    `UPDATE listings
        SET status=?2, attrs=?3, cover_media=?4, updated_at=?5,
            reviewed_content_hash=?6, reviewed_at=?7, reviewed_by=?8
      WHERE id=?1 AND status=?9 AND authority_version=?10`,
  ).bind(
    id, next, JSON.stringify(attrs), coverMedia, now,
    reviewedHash, reviewedAt, reviewedBy, row.status, Number(row.authority_version ?? 0),
  ).run();
  if (!(updated.meta?.changes ?? 0)) {
    return json({ error: "conflict", message: "This listing changed while the moderation action was running. Reload and try again." }, 409);
  }
  await writeListingApprovalHistory(env, {
    listingId: id,
    actorId: a.uid,
    action,
    previousStatus: row.status,
    nextStatus: next,
    reason: reasonForHistory,
    posterStatus: attrs.poster?.status ?? null,
  }).run();
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
