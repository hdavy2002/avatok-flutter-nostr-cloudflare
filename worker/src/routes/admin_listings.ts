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
import { publishListingAuthoritative, reviewedContentHash, normListingFields, polishListingCopy } from "./listings";
import { listingBlockers } from "../lib/listing_blockers";
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

  // [ADMIN-PLAIN-1 2026-09-05] Resolve the actors to NAMES.
  //
  // The timeline printed a raw clerk uid on every row
  // ("BY USER_3AUQQADIDHJFTJTTKLD0DTKM8MB"), which tells a non-technical
  // reviewer nothing about who did what — the owner's actual complaint. One IN
  // query over the distinct actors, not a join, because the history is capped at
  // 50 rows and is usually two or three distinct people.
  const actorIds = [...new Set(history.map((h: any) => String(h.actor_id ?? "")).filter(Boolean))];
  const actorNames: Record<string, string> = {};
  if (actorIds.length) {
    try {
      const placeholders = actorIds.map((_, i) => `?${i + 1}`).join(",");
      const us = await db.prepare(
        `SELECT uid, display_name, handle FROM users WHERE uid IN (${placeholders})`,
      ).bind(...actorIds).all<any>();
      for (const u of us.results ?? []) {
        const name = String(u.display_name ?? "").trim() || (u.handle ? `@${u.handle}` : "");
        if (name) actorNames[String(u.uid)] = name;
      }
    } catch { /* names are a nicety; the timeline still renders without them */ }
  }

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

  // [LISTING-BLOCKERS-1 2026-09-05] The reviewer sees exactly what publish will
  // refuse, BEFORE they approve. Previously the queue showed no problem at all
  // and the reviewer found out only when Publish 400'd — on a listing they had
  // already approved, and whose schedule the creator could no longer edit.
  const blockers = await listingBlockers(env, row);

  return json({
    listing, creator, poster, history, category, slots,
    actor_names: actorNames,
    blockers,
    publishable: blockers.length === 0,
  });
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

const ALLOWED_ACTIONS = ["approve_listing", "reject_listing", "generate_poster", "regenerate_poster", "approve_poster", "reject_poster", "publish", "reapprove_content", "regenerate_copy", "restore_copy"];

// [ADMIN-EDIT-1 2026-09-05] What a reviewer may change on someone else's listing.
//
// Until now the answer was NOTHING. The admin queue could approve, reject with a
// reason, and run poster actions — and that was the whole toolkit, so a listing
// that was 95% right had to be bounced back to its creator over a typo or a
// missing start time. The owner's objection on 2026-09-05: "as an admin, I
// should have full editing capabilities, in case I need to adjust something",
// and with four thousand listings in a queue, bouncing each one is not a plan.
//
// This list is deliberately CONTENT ONLY. Excluded, and why:
//   status        — that is what the moderation actions are for, and they carry
//                   the transition table and the review-hash binding
//   kind, vertical— structural; changing them re-files the listing into a
//                   different product with different rules mid-review
//   creator_id    — an edit must never change who owns or gets paid for a listing
//   cover_media   — owned by the poster actions, which merge creator photos
//   attrs.poster  — server state, already stripped of `__` keys above
const ADMIN_EDITABLE = new Set([
  "title", "blurb", "description", "category",
  "price", "currency_display", "free_entry",
  "starts_at", "duration_min", "schedule_mode", "recurrence_days", "recurrence_time",
  "timezone", "capacity", "max_per_booking", "response_time_min",
  "location", "country", "video_url", "spoken_lang", "adults_only",
  "credential", "media_mode",
]);

/**
 * PUT /api/admin/listings/:id — a reviewer edits the listing's content.
 *
 * [ADMIN-EDIT-1 2026-09-05] Owner decision: the edit is LOGGED and the listing
 * KEEPS its approval. The reviewer is the approver, so bouncing it back to
 * pending_review would mean re-approving your own correction — busywork that
 * teaches reviewers to stop using the feature.
 *
 * That is a real trade: it means an admin edit is not itself reviewed. It is
 * mitigated by making the change fully attributable rather than by adding a
 * second gate — every edit writes a `admin_edit` row into
 * listing_approval_history carrying the exact before/after of each field, plus
 * an admin_audit row, plus a PostHog event. "Who did what" was the owner's
 * actual worry, and a diff answers it better than a status flip.
 */
export async function adminEditListing(req: Request, env: Env, id: string): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const body = await req.json().catch(() => ({})) as any;
  const db = env.DB_META;
  const row = await db.prepare("SELECT * FROM listings WHERE id=?1").bind(id).first<any>();
  if (!row) return json({ error: "not found" }, 404);

  // A cancelled or completed listing is history. Editing one would rewrite what
  // a buyer already saw and, for completed, what they already paid for.
  if (row.status === "cancelled" || row.status === "completed") {
    return json({ error: "listing_closed", message: `A ${row.status} listing cannot be edited.` }, 409);
  }

  const patch = body && typeof body.fields === "object" && body.fields ? body.fields : body;
  const requested = Object.keys(patch ?? {}).filter((k) => k !== "action" && k !== "fields");
  const rejected = requested.filter((k) => !ADMIN_EDITABLE.has(k));
  if (rejected.length) {
    return json({
      error: "field_not_editable",
      message: `These fields cannot be edited here: ${rejected.join(", ")}.`,
      fields: rejected,
    }, 400);
  }
  if (!requested.length) return json({ error: "nothing to update" }, 400);

  // Same coercion the creator's own PUT applies — see normListingFields.
  const norm = normListingFields(patch);
  const cols = Object.keys(norm).filter((k) => ADMIN_EDITABLE.has(k));
  if (!cols.length) return json({ error: "nothing to update" }, 400);

  // The diff is the point of this route. Captured BEFORE the write, from the row
  // we read, so it records what actually changed rather than what was asked for
  // — an admin who "changes" a field to the value it already held should not
  // leave a history entry claiming they changed something.
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const c of cols) {
    const before = row[c] ?? null;
    const after = (norm as any)[c] ?? null;
    if (String(before) !== String(after)) changes[c] = { from: before, to: after };
  }
  if (!Object.keys(changes).length) {
    return json({ ok: true, listing_id: id, changed: [], message: "No values differed — nothing was written." });
  }

  const now = Date.now();

  // [ADMIN-EDIT-2 2026-09-05] RE-BIND THE APPROVAL TO WHAT THE ADMIN JUST WROTE.
  //
  // Without this the feature is self-defeating, and was: publish refuses with
  // `review_stale` when reviewed_content_hash no longer matches the listing
  // (routes/listings.ts), and REVIEW_MATERIAL_FIELDS covers starts_at,
  // duration_min, capacity, price, title and most of what an admin would edit.
  // So on 2026-09-05 the very first admin edit — setting the missing start time
  // on listing 845567cb — made the listing unpublishable the moment it fixed it.
  //
  // Re-binding is exactly the owner's decision ("log it, keep approval") and is
  // sound on its own terms: the hash exists so a listing cannot be silently
  // changed AFTER a human judged it, and here a human is judging it right now.
  // The reviewer is the approver; making them re-approve their own correction is
  // the busywork that stops people using the feature.
  //
  // Only re-bind a listing that ALREADY carries a binding. A draft or a
  // pending_review listing has none, and minting one here would fabricate an
  // approval nobody gave — the precise hole the hash was built to close.
  const wasBound = !!row.reviewed_content_hash;
  const rebindHash = wasBound
    ? await reviewedContentHash({ ...row, ...norm })
    : null;

  const setSql = cols.map((c, i) => `${c}=?${i + 2}`).join(", ");
  const rebindSql = wasBound
    ? `, reviewed_content_hash=?${cols.length + 4}, reviewed_at=?${cols.length + 5}, reviewed_by=?${cols.length + 6}`
    : "";
  const updated = await db.prepare(
    `UPDATE listings SET ${setSql}, updated_at=?${cols.length + 2}${rebindSql}
      WHERE id=?1 AND authority_version=?${cols.length + 3}`,
  ).bind(
    id, ...cols.map((c) => (norm as any)[c] ?? null), now, Number(row.authority_version ?? 0),
    ...(wasBound ? [rebindHash, now, a.uid] : []),
  ).run();
  if (!(updated.meta?.changes ?? 0)) {
    return json({ error: "conflict", message: "This listing changed while you were editing. Reload and try again." }, 409);
  }

  // Attribution, in the same table the reviewer already reads as the audit
  // timeline — so an edit sits inline with the approve/reject it happened
  // between, rather than in a separate log nobody opens.
  await writeListingApprovalHistory(env, {
    listingId: id,
    actorId: a.uid,
    action: "admin_edit",
    previousStatus: row.status,
    nextStatus: row.status,
    reason: JSON.stringify(changes).slice(0, 2000),
    posterStatus: null,
  }).run();
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(crypto.randomUUID(), a.uid, "listing_admin_edit", id,
      JSON.stringify({ status: row.status, creator_id: row.creator_id ?? null, changes }), now).run();
  } catch { /* audit is best-effort, matching the other admin routes */ }

  safeTrack(env, a.uid, "listing_admin_edit", {
    listing_id: id,
    admin_id: a.uid,
    creator_id: row.creator_id ?? null,
    status: row.status ?? null,
    fields: Object.keys(changes).join(","),
    field_count: Object.keys(changes).length,
    // [ADMIN-EDIT-2] Whether the approval was carried across. `false` on an
    // approved listing would mean the edit just made it unpublishable, which is
    // the bug this property exists to make visible rather than discoverable.
    rebound: wasBound,
  });

  // The whole reason an admin edits is to make a listing publishable, so answer
  // the question they are actually asking rather than making them click again.
  const fresh = await db.prepare("SELECT * FROM listings WHERE id=?1").bind(id).first<any>();
  const blockers = await listingBlockers(env, fresh ?? row);
  return json({
    ok: true,
    listing_id: id,
    changed: Object.keys(changes),
    changes,
    publishable: blockers.length === 0,
    blockers,
  });
}

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
  // [COPY-PIPELINE-1] Set by regenerate_copy / restore_copy; written in the same
  // statement as everything else below so the copy change and the attrs that
  // describe it can never land apart.
  let copyRewrite: { title: string; blurb: string; description: string } | null = null;

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
          // [FACE-PHOTO-1] Same source on the admin regenerate path.
          facePhotoUrl: (() => {
            const f = (attrs as any)?.face_photo;
            const u = typeof f === "string" ? f : String(f?.url ?? "");
            return /^https:\/\//i.test(u) ? u : null;
          })(),
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
  } else if (action === "regenerate_copy") {
    // [COPY-PIPELINE-1 2026-09-05] "Ask the AI to write this again."
    //
    // Owner request: before approving, an admin should be able to have the
    // description or title rewritten rather than bouncing the listing back over
    // wording. Runs the same pass submit runs — one implementation, so an admin
    // regenerate and a creator submit cannot produce differently-shaped text.
    //
    // Regenerates from the ORIGINAL where we kept one, not from the already
    // polished text. Polishing a polish drifts: each pass trims and rephrases
    // what the last one produced, and three rounds in, the listing no longer
    // says what the creator wrote.
    const orig = attrs.copy_original ?? null;
    const base: Record<string, any> = {
      ...row,
      title: orig?.title ?? row.title,
      blurb: orig?.blurb ?? row.blurb,
      description: orig?.description ?? row.description,
    };
    const polished = await polishListingCopy(env, a.uid, base);
    if (!polished) {
      return json({
        error: "copy_unchanged",
        message: "The copy pass had nothing to change, or the model was unavailable. Nothing was written.",
      }, 409);
    }
    attrs.copy_original = polished.original;
    attrs.copy_polish = { ...polished.meta, by_admin: a.uid };
    copyRewrite = { title: base.title, blurb: base.blurb, description: base.description };
  } else if (action === "restore_copy") {
    // The other direction: put the creator's own words back. The polish is a
    // suggestion the platform applied on their behalf, so an admin who thinks it
    // read better before must be able to undo it — otherwise "keep the original"
    // is a promise nothing acts on.
    const orig = attrs.copy_original ?? null;
    if (!orig) {
      return json({ error: "no_original", message: "This listing's copy was never rewritten." }, 409);
    }
    copyRewrite = {
      title: String(orig.title ?? row.title ?? ""),
      blurb: String(orig.blurb ?? row.blurb ?? ""),
      description: String(orig.description ?? row.description ?? ""),
    };
    delete attrs.copy_original;
    delete attrs.copy_polish;
  } else if (action === "reapprove_content") {
    // [ADMIN-EDIT-2 2026-09-05] "I have read the current content and it is still
    // approved" — re-bind reviewed_content_hash without a status change.
    //
    // Publish refuses with `review_stale` when the listing no longer matches the
    // content that was approved, and before this there was NO admin way back:
    // approved -> approved is not a legal transition, so the only route was to
    // reject the listing and make the creator resubmit. That is the right
    // answer when a CREATOR changed something after approval; it is absurd when
    // the admin changed it themselves, or when a fix is one field wide.
    //
    // This is an approval, not a bypass: it writes the same three review-binding
    // columns `approve_listing` writes, stamped with this admin's id, and it is
    // only reachable from a status that has already been approved. An admin
    // clicking it is asserting they have read what is on the screen — which is
    // exactly what they assert when they click Approve.
    if (String(row.status) !== "approved" && String(row.status) !== "published") {
      return json({
        error: "not_approved",
        message: "Only an approved or published listing can have its content re-approved.",
        status: row.status,
      }, 409);
    }
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
  if (action === "approve_listing" || action === "reapprove_content") {
    // Hash the content as it will actually be WRITTEN below: `attrs`/`coverMedia`
    // already reflect this request's poster-generation cover-cap merge (if any),
    // and every other listing field is untouched by this action.
    //
    // [ADMIN-EDIT-2] `reapprove_content` writes the same three columns with no
    // status change — see the branch above for why that is an approval and not a
    // bypass.
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
            reviewed_content_hash=?6, reviewed_at=?7, reviewed_by=?8,
            title=?11, blurb=?12, description=?13
      WHERE id=?1 AND status=?9 AND authority_version=?10`,
  ).bind(
    id, next, JSON.stringify(attrs), coverMedia, now,
    reviewedHash, reviewedAt, reviewedBy, row.status, Number(row.authority_version ?? 0),
    // [COPY-PIPELINE-1] Unchanged for every other action — bound to the row's own
    // values so a poster approval cannot blank a title.
    copyRewrite ? copyRewrite.title : (row.title ?? null),
    copyRewrite ? copyRewrite.blurb : (row.blurb ?? null),
    copyRewrite ? copyRewrite.description : (row.description ?? null),
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
