// [ADMIN2-EVENTS 2026-09-26] Admin 2 — the Events section (Saa Thum's own pujas/havans).
// Contract: Specs/SPEC-2026-09-26-ADMIN-2.md ("Events"). Pure rules:
// lib/admin2_events_logic.ts. Registered from the admin2 dispatcher
// (routes/admin2.ts, "events (agent B)" section) via ADMIN2_EVENT_ROUTES.
//
//   GET  /api/admin/v2/events?tab&q&cat         list + per-tab counts
//   GET  /api/admin/v2/events/meta              categories, price floor, deity hints
//   GET  /api/admin/v2/events/:id               detail + live listing_blockers + video
//   POST /api/admin/v2/events                   create a DRAFT
//   PUT  /api/admin/v2/events/:id               edit
//   POST /api/admin/v2/events/:id/publish       approve + publish, one action
//   POST /api/admin/v2/events/:id/unpublish     back to the Drafts tab (nothing sold only)
//   POST /api/admin/v2/events/:id/cancel        refund open orders, then cancel
//   POST /api/admin/v2/events/:id/poster        {action:'generate'|'keep'} AI poster
//
// Registered with one spread line in routes/admin2.ts ADMIN2_ROUTES (see bottom).
//
// HOW AN ADMIN EVENT GOES LIVE WITHOUT A CREATOR REVIEW LOOP — and why it is not a bypass.
// Every step is an EXISTING authority, called in order, as the admin:
//   1. create   -> routes/listings.ts createListing() (the creator path, run as the admin's
//                  own uid: identity gate, price floor, moderation, attrs policy, insert).
//   2. edit     -> routes/admin_listings.ts adminEditListing() (ADMIN_EDITABLE allowlist,
//                  schedule lock on published events, logged diff, approval re-bound).
//                  The two fields that route deliberately does not own — the cover image and
//                  attrs.deity — are written here, under the same authority_version guard,
//                  with the same history row and the same hash re-bind.
//   3. publish  -> adminListingAction('approve_listing') then adminListingAction('publish'),
//                  i.e. publishListingAuthoritative() with actor 'admin': listing_blockers,
//                  KYC flag, identity gate, FTS, fanout. Nothing is re-implemented; a
//                  blocker there is shown to the admin verbatim. Admin-owned listings skip
//                  the creator Google Calendar gates and the calendar hold
//                  (adminListingsSkipCalendar — lib/admin_calendar_exempt.ts).
//      The poster gate (attrs.poster.status must be 'approved') is met by the admin's own
//      decision: an uploaded cover is recorded as the approved poster (provider
//      'admin_cover'), or a generated AI poster is approved with approve_poster.
//   4. cancel   -> refundOpenOrdersForListing() FIRST (the rule creator cancel and admin
//                  reject use), then the status write through checkTransition().
import type { Env } from "../types";
import { json } from "../util";
import type { Admin2RouteDef } from "./admin2";
import { requireAdmin } from "./admin_money";
import { track, trackException } from "../hooks";
import { createListing, ftsSync, reviewedContentHash } from "./listings";
import { adminEditListing, adminListingAction } from "./admin_listings";
import { listingBlockers } from "../lib/listing_blockers";
import { checkTransition } from "../lib/listing_transitions";
import { scheduleState } from "../lib/listing_schedule";
import { refundOpenOrdersForListing } from "./commercial_lifecycle";
import { releaseBlocks } from "../cal/engine";
import { releaseListingReservations } from "../cal/listing_reservations";
import { startsMsSql, SMOKE_LISTING_ID } from "../lib/me_dashboard_data";
import {
  DEITY_SUGGESTIONS, EVENT_TABS, INTENTIONS, nextSeo, type AttrPatch, type SeoPatch, LIMITS, MIN_PRICE_RUPEES, coverUrlOf, likeContains, msToIst,
  nextCoverMedia, normalizeEventInput, parseTab, posterPlan, splitPatch, tabOf, tabSql,
  type EventPatch, type EventTab,
} from "../lib/admin2_events_logic";

const APP = "saathum";
/** The listing module's app tag — releaseBlocks() keys calendar blocks on it. */
const LISTINGS_APP = "avaexplore";

const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ error, message, ...extra }, status);

type Admin = { uid: string };
type Exec = ExecutionContext | undefined;

async function admin(req: Request, env: Env): Promise<Admin | Response> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) {
    return a.status === 403 ? err(403, "admin_only", "Admins only.") : err(a.status, "unauthorized", "Please sign in again.");
  }
  return a;
}

async function readBody(req: Request, max = 32_768): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > max) return null;
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** A same-auth internal request to another handler (the admin's own token rides along). */
function inner(req: Request, method: string, body: unknown): Request {
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Request(req.url, { method, headers, body: JSON.stringify(body ?? {}) });
}

async function readJson(res: Response): Promise<Record<string, any>> {
  try { return (await res.clone().json()) as Record<string, any>; } catch { return {}; }
}

function attrsOf(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object") return raw as Record<string, any>;
  if (typeof raw !== "string" || !raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

function safeTrack(env: Env, uid: string, event: string, props: Record<string, unknown>): void {
  try { void track(env, uid, event, APP, props); } catch { /* telemetry is best-effort */ }
}

async function history(env: Env, a: { listingId: string; actorId: string; action: string; prev: string | null; next: string | null; reason?: string | null; poster?: string | null }): Promise<void> {
  try {
    await env.DB_META.prepare(
      `INSERT INTO listing_approval_history
       (id, listing_id, actor_id, action, previous_status, next_status, reason, poster_status, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    ).bind(crypto.randomUUID(), a.listingId, a.actorId, a.action, a.prev, a.next, a.reason ?? null, a.poster ?? null, Date.now()).run();
  } catch (e) {
    await trackException(env, e, { uid: a.actorId, route: "admin2_events.history", handled: true, app_name: APP });
  }
}

async function audit(env: Env, adminId: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(crypto.randomUUID(), adminId, action, target, JSON.stringify(meta), Date.now()).run();
  } catch { /* audit is best-effort, matching the other admin routes */ }
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/** Seats that count as booked: the same entitlement states the public card counts. */
const SEATS_SQL = `(SELECT COUNT(*) FROM commercial_entitlements ce
   WHERE ce.listing_id=l.id AND ce.role IN ('viewer','buyer') AND ce.state IN ('reserved','held','active','consumed'))`;
/** UPI payments started or received but not yet a booking (?1 = now). */
const PENDING_PAY_SQL = `(SELECT COUNT(*) FROM hdfc_sms_payment_intents h
   WHERE h.listing_id=l.id AND h.commercial_order_id IS NULL
     AND (h.status IN ('payment_received','review_pending') OR (h.status='pending' AND h.expires_at>?1)))`;

const BASE_WHERE = `l.kind='live_event' AND l.id<>'${SMOKE_LISTING_ID}'
  AND (l.category IN (SELECT id FROM listing_categories WHERE active=1) OR l.creator_id=?2)`;

function shapeRow(r: any, now: number) {
  const attrs = attrsOf(r.attrs);
  const starts = r.starts_ms != null ? Number(r.starts_ms) : null;
  const row = { kind: "live_event", status: r.status, starts_at: starts, duration_min: r.duration_min };
  return {
    id: String(r.id),
    title: String(r.title ?? ""),
    category: r.category ?? null,
    category_label: r.category_label ?? null,
    deity: typeof attrs.deity === "string" && attrs.deity ? attrs.deity : null,
    image_url: coverUrlOf(r.cover_media),
    starts_at: starts,
    duration_min: r.duration_min != null ? Number(r.duration_min) : null,
    price_paise: Math.max(0, Math.round(Number(r.price ?? 0) * 100)),
    capacity: r.capacity != null ? Number(r.capacity) : null,
    seats_booked: Number(r.seats_booked ?? 0),
    pending_payments: Number(r.pending_payments ?? 0),
    status: String(r.status ?? ""),
    tab: tabOf(row, now),
    schedule_state: scheduleState(row, now),
    youtube_set: !!r.youtube_video_id,
    poster_status: attrs.poster?.status ?? null,
    book_url: `/book/${encodeURIComponent(String(r.id))}`,
    updated_at: Number(r.updated_at ?? 0),
  };
}

const ROW_COLS = `l.id, l.title, l.category, c.label AS category_label, l.attrs, l.cover_media,
  ${startsMsSql("l")} AS starts_ms, l.duration_min, l.price, l.capacity, l.status, l.updated_at, l.creator_id,
  ${SEATS_SQL} AS seats_booked, ${PENDING_PAY_SQL} AS pending_payments, v.youtube_video_id`;

export async function adminEventsList(req: Request, env: Env): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const u = new URL(req.url).searchParams;
  const now = Date.now();
  const tab = parseTab(u.get("tab"));
  const binds: unknown[] = [now, a.uid];
  const where = [BASE_WHERE];
  const q = (u.get("q") ?? "").trim();
  if (q) {
    binds.push(likeContains(q)); const like = `?${binds.length}`;
    binds.push(`${q.slice(0, 80)}%`); const pre = `?${binds.length}`;
    where.push(`(lower(l.title) LIKE ${like} ESCAPE '\\' OR l.id LIKE ${pre})`);
  }
  const cat = (u.get("cat") ?? "").trim();
  if (cat) { binds.push(cat.slice(0, 40)); where.push(`l.category=?${binds.length}`); }
  const whereSql = where.join(" AND ");
  const tabExpr = tabSql("l", "?1");

  const counts = await env.DB_META.prepare(
    `SELECT ${tabExpr} AS tab, COUNT(*) AS n FROM listings l WHERE ${whereSql} GROUP BY 1`,
  ).bind(...binds).all<{ tab: EventTab; n: number }>();
  const countMap: Record<EventTab, number> = { upcoming: 0, live: 0, past: 0, drafts: 0, cancelled: 0 };
  for (const r of counts.results ?? []) if ((EVENT_TABS as readonly string[]).includes(r.tab)) countMap[r.tab] = Number(r.n);

  binds.push(tab); const tabRef = `?${binds.length}`;
  const order = tab === "upcoming" || tab === "live" ? `starts_ms ASC, l.id ASC`
    : tab === "drafts" ? `l.updated_at DESC` : `starts_ms DESC, l.updated_at DESC`;
  const rows = await env.DB_META.prepare(
    `SELECT ${ROW_COLS}
       FROM listings l
       LEFT JOIN listing_categories c ON c.id=l.category
       LEFT JOIN event_videos v ON v.listing_id=l.id
      WHERE ${whereSql} AND ${tabExpr}=${tabRef}
      ORDER BY ${order} LIMIT 200`,
  ).bind(...binds).all<any>();
  return json({ now, tab, counts: countMap, items: (rows.results ?? []).map((r) => shapeRow(r, now)) });
}

export async function adminEventsMeta(req: Request, env: Env): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const cats = await env.DB_META.prepare(
    "SELECT id, label FROM listing_categories WHERE active=1 ORDER BY sort ASC, label ASC",
  ).all<{ id: string; label: string }>();
  return json({
    categories: cats.results ?? [],
    min_price_rupees: MIN_PRICE_RUPEES,
    duration: { min: LIMITS.durationMin, max: LIMITS.durationMax },
    deity_suggestions: DEITY_SUGGESTIONS,
    intentions: Object.entries(INTENTIONS).map(([id, label]) => ({ id, label })),
    limits: LIMITS,
  });
}

async function loadRow(env: Env, id: string): Promise<any | null> {
  if (!id || id.length > 200) return null;
  return env.DB_META.prepare("SELECT * FROM listings WHERE id=?1").bind(id).first<any>();
}

async function detailPayload(env: Env, id: string, adminUid: string): Promise<Record<string, unknown> | null> {
  const now = Date.now();
  const row = await loadRow(env, id);
  if (!row || String(row.kind) !== "live_event") return null;
  const listRow = await env.DB_META.prepare(
    `SELECT ${ROW_COLS} FROM listings l
       LEFT JOIN listing_categories c ON c.id=l.category
       LEFT JOIN event_videos v ON v.listing_id=l.id
      WHERE l.id=?3`,
  ).bind(now, adminUid, id).first<any>();
  const video = await env.DB_META.prepare("SELECT youtube_video_id, source_url FROM event_videos WHERE listing_id=?1")
    .bind(id).first<{ youtube_video_id: string; source_url: string | null }>();
  const attrs = attrsOf(row.attrs);
  const blockers = ["cancelled", "completed"].includes(String(row.status)) ? [] : await listingBlockers(env, row);
  const plan = posterPlan(attrs, row.cover_media);
  const startsMs = listRow?.starts_ms != null ? Number(listRow.starts_ms) : null;
  const covers = (() => { try { const v = JSON.parse(String(row.cover_media ?? "[]")); return Array.isArray(v) ? v : []; } catch { return []; } })();
  return {
    event: {
      ...(listRow ? shapeRow(listRow, now) : {}),
      blurb: row.blurb ?? null,
      description: row.description ?? null,
      performed_by: row.performed_by ?? null,
      // [SAATHUM-EVENT-FIELDS-1] Book now card fields + SEO + share line.
      location: row.location ?? null,
      intention: typeof attrs.intention === "string" ? attrs.intention : null,
      prasad_courier: typeof attrs.prasad_courier === "boolean" ? attrs.prasad_courier : true,
      // [SAATHUM-CHADHAVA 2026-09-26] video_download replaces replay; fall back to the old key.
      video_download: typeof attrs.video_download === "boolean" ? attrs.video_download : (typeof attrs.replay === "boolean" ? attrs.replay : true),
      visibility: attrs.visibility === "private" ? "private" : "public",
      prasad_price_rupees: Number.isInteger(attrs.prasad_price_rupees) ? attrs.prasad_price_rupees : 99,
      video_download_url: typeof attrs.video_download_url === "string" && attrs.video_download_url ? attrs.video_download_url : null,
      guide_slug: typeof attrs.guide_slug === "string" ? attrs.guide_slug : null,
      seo: attrs.seo && typeof attrs.seo === "object" ? {
        title: String(attrs.seo.title ?? ""), description: String(attrs.seo.description ?? ""),
        title_source: attrs.seo.title_source === "admin" ? "admin" : "auto",
        description_source: attrs.seo.description_source === "admin" ? "admin" : "auto",
      } : null,
      ad_hook: typeof attrs.ad_hook?.text === "string" ? attrs.ad_hook.text : null,
      slug: row.slug ?? null,
      start_ist: startsMs ? msToIst(startsMs) : null,
      price_rupees: Number(row.price ?? 0),
      manual_cover_url: covers.find((c: any) => c && c.source !== "ai_poster")?.url ?? null,
      ai_poster_url: attrs.poster?.url ?? covers.find((c: any) => c && c.source === "ai_poster")?.url ?? null,
      poster: attrs.poster ? { status: attrs.poster.status ?? null, provider: attrs.poster.provider ?? null, url: attrs.poster.url ?? null, error: attrs.poster.error ?? null } : null,
      creator_id: row.creator_id ?? null,
      created_by_you: row.creator_id === adminUid,
      created_at: Number(row.created_at ?? 0),
    },
    youtube: video ? { video_id: video.youtube_video_id, url: video.source_url ?? `https://www.youtube.com/watch?v=${video.youtube_video_id}` } : null,
    blockers,
    publishable: blockers.length === 0 && plan.kind !== "needs_image",
    poster_plan: plan,
  };
}

export async function adminEventDetail(req: Request, env: Env, id: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const out = await detailPayload(env, id, a.uid);
  if (!out) return err(404, "not_found", "No such event.");
  return json(out);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Cover + the attrs keys this lane owns (deity, intention, prasad_courier, replay,
 * guide_slug — [SAATHUM-EVENT-FIELDS-1]): the fields adminEditListing does not own.
 * Same guards it uses. Returns an error Response, or null when written / nothing to do.
 */
async function writeMediaAndAttrs(env: Env, adminUid: string, id: string, cover: string | null | undefined, attrPatch: AttrPatch): Promise<Response | null> {
  const attrKeys = Object.keys(attrPatch) as (keyof AttrPatch)[];
  if (cover === undefined && !attrKeys.length) return null;
  const row = await loadRow(env, id);
  if (!row) return err(404, "not_found", "No such event.");
  if (row.status === "cancelled" || row.status === "completed") {
    // [SAATHUM-CHADHAVA 2026-09-26] The one exception: the admin can paste the video
    // download link on a completed event (video_download_url), any time after it ends.
    const otherKeys = attrKeys.filter((k) => k !== "video_download_url");
    if (cover !== undefined || otherKeys.length) {
      return err(409, "listing_closed", `A ${row.status} event cannot be edited.`);
    }
  }
  const attrs = attrsOf(row.attrs);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  let coverMedia: string | null = row.cover_media ?? null;
  if (cover !== undefined) {
    const next = nextCoverMedia(row.cover_media, cover);
    const nextStr = next.length ? JSON.stringify(next) : null;
    if (String(nextStr) !== String(row.cover_media ?? null)) {
      changes.cover_media = { from: row.cover_media ?? null, to: nextStr };
      coverMedia = nextStr;
      // An approved admin-cover poster follows the upload; removing the upload revokes it.
      if (attrs.poster?.provider === "admin_cover") {
        if (cover) attrs.poster = { ...attrs.poster, url: cover, completed_at: Date.now() };
        else delete attrs.poster;
      }
    }
  }
  for (const k of attrKeys) {
    const to = attrPatch[k] ?? null;
    const from = attrs[k] ?? null;
    if (from === to) continue;
    changes[k] = { from, to };
    if (to === null || to === "") delete attrs[k]; else attrs[k] = to;
  }
  // [SAATHUM-CHADHAVA 2026-09-26] video_download replaces replay: once the admin has
  // touched video_download this save, the stale replay key is retired.
  if (attrKeys.includes("video_download") && attrs.replay !== undefined) {
    changes.replay = { from: attrs.replay, to: null };
    delete attrs.replay;
  }
  if (!Object.keys(changes).length) return null;
  const attrsStr = JSON.stringify(attrs);
  // Same re-bind rule as adminEditListing ([ADMIN-EDIT-2]): only a listing that already
  // carries an approval is re-bound; the admin making the change is the approver.
  const wasBound = !!row.reviewed_content_hash;
  const rebind = wasBound ? await reviewedContentHash({ ...row, attrs: attrsStr, cover_media: coverMedia }) : null;
  const now = Date.now();
  const res = await env.DB_META.prepare(
    `UPDATE listings SET cover_media=?2, attrs=?3, updated_at=?4
       ${wasBound ? ", reviewed_content_hash=?6, reviewed_at=?4, reviewed_by=?7" : ""}
     WHERE id=?1 AND authority_version=?5`,
  ).bind(id, coverMedia, attrsStr, now, Number(row.authority_version ?? 0), ...(wasBound ? [rebind, adminUid] : [])).run();
  if (!(res.meta?.changes ?? 0)) return err(409, "conflict", "This event changed while you were editing. Reload and try again.");
  await history(env, { listingId: id, actorId: adminUid, action: "admin_edit", prev: row.status, next: row.status, reason: JSON.stringify(changes).slice(0, 2000) });
  await audit(env, adminUid, "listing_admin_edit", id, { status: row.status, changes, via: "admin2" });
  if (row.status === "published" || row.status === "live") await ftsSync(env, id).catch(() => undefined);
  return null;
}

/**
 * [SAATHUM-EVENT-FIELDS-1] Refresh attrs.seo from the saved row (auto parts always
 * follow the current title/blurb/price/place; admin-typed parts are kept). `seo` is
 * a RESERVED attrs key (routes/listings.ts), so it is outside reviewedContentHash and
 * writing it never makes an approval stale. json_set on the stored row, like
 * attrs.ad_hook, so it never clobbers a concurrent write to other attrs keys.
 * Best-effort: a failure here is logged, never fails the save.
 */
async function refreshSeo(env: Env, adminUid: string, id: string, patch: SeoPatch | undefined): Promise<void> {
  try {
    const row = await loadRow(env, id);
    if (!row) return;
    const attrs = attrsOf(row.attrs);
    const next = nextSeo({ ...row, deity: attrs.deity }, attrs.seo ?? null, patch);
    const cur = attrs.seo ?? {};
    if (cur.title === next.title && cur.description === next.description && cur.title_source === next.title_source && cur.description_source === next.description_source) return;
    await env.DB_META.prepare("UPDATE listings SET attrs=json_set(COALESCE(NULLIF(attrs,''),'{}'),'$.seo',json(?2)) WHERE id=?1")
      .bind(id, JSON.stringify(next)).run();
    safeTrack(env, adminUid, "admin2_event_seo_written", { listing_id: id, title_source: next.title_source, description_source: next.description_source });
  } catch (e) {
    await trackException(env, e, { uid: adminUid, route: "admin2_events.refreshSeo", handled: true, app_name: APP });
  }
}

/** adminEditListing for the ADMIN_EDITABLE fields. Returns an error Response or null. */
async function runAdminEdit(req: Request, env: Env, id: string, edit: Record<string, unknown>, exec: Exec): Promise<Response | null> {
  if (!Object.keys(edit).length) return null;
  const res = await adminEditListing(inner(req, "PUT", { fields: edit }), env, id, exec);
  if (res.ok) return null;
  const b = await readJson(res);
  if (b.error === "nothing to update") return null;
  return json({ ...b, message: b.message ?? b.error ?? "The event could not be saved." }, res.status);
}

export async function adminEventCreate(req: Request, env: Env, exec: Exec): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the event as JSON.");
  const { patch, errors } = normalizeEventInput(b, { partial: false });
  if (errors.length) return err(400, "invalid_event", errors[0].message, { field: errors[0].field, errors });
  const cat = await env.DB_META.prepare("SELECT 1 FROM listing_categories WHERE id=?1 AND active=1").bind(patch.category).first();
  if (!cat) return err(400, "invalid_event", "That category is not available — pick another one.", { field: "category" });

  // The creator create path, run as the admin's own uid (see file header, step 1).
  const createBody: Record<string, unknown> = {
    kind: "live_event",
    title: patch.title,
    category: patch.category,
    schedule_mode: "fixed_date",
    timezone: "Asia/Kolkata",
    performed_by: patch.performed_by ?? "Saa Thum",
  };
  for (const k of ["blurb", "description", "starts_at", "duration_min", "price"] as const) {
    if (patch[k] !== undefined && patch[k] !== null) createBody[k] = patch[k];
  }
  if (patch.cover_url) createBody.cover_media = [{ type: "image", url: patch.cover_url }];
  const created = await createListing(inner(req, "POST", createBody), env);
  const cb = await readJson(created);
  if (!created.ok || !cb.listing_id) {
    safeTrack(env, a.uid, "admin2_event_create_failed", { status: created.status, error: cb.error ?? null });
    return json({ ...cb, error: cb.error ?? "create_failed", message: cb.message ?? cb.error ?? "The event could not be created." }, created.ok ? 500 : created.status);
  }
  const id = String(cb.listing_id);
  // Cover source tag + attrs (createListing strips cover `source`), then capacity/location via the admin editor.
  const split = splitPatch(patch as EventPatch);
  const createAttrs: AttrPatch = {};
  for (const [k, v] of Object.entries(split.attrs)) if (v !== null && v !== undefined && v !== "") (createAttrs as any)[k] = v;
  const media = await writeMediaAndAttrs(env, a.uid, id, patch.cover_url ?? undefined, createAttrs);
  if (media) return media;
  const later: Record<string, unknown> = {};
  if (patch.capacity) later.capacity = patch.capacity;
  if (patch.location) later.location = patch.location;
  // [SAATHUM-CHADHAVA 2026-09-26] Private events are locked to 1 seat, server-side.
  if (patch.visibility === "private") later.capacity = 1;
  if (Object.keys(later).length) {
    const e = await runAdminEdit(req, env, id, later, exec);
    if (e) return e;
  }
  await refreshSeo(env, a.uid, id, split.seo);
  await history(env, { listingId: id, actorId: a.uid, action: "admin2_create", prev: null, next: "draft" });
  safeTrack(env, a.uid, "admin2_event_created", { listing_id: id, category: patch.category });
  const out = await detailPayload(env, id, a.uid);
  return json({ ok: true, id, ...(out ?? {}) }, 201);
}

export async function adminEventUpdate(req: Request, env: Env, id: string, exec: Exec): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the changes as JSON.");
  const row = await loadRow(env, id);
  if (!row || String(row.kind) !== "live_event") return err(404, "not_found", "No such event.");
  const { patch, errors } = normalizeEventInput(b, { partial: true });
  if (errors.length) return err(400, "invalid_event", errors[0].message, { field: errors[0].field, errors });
  if (patch.category) {
    const cat = await env.DB_META.prepare("SELECT 1 FROM listing_categories WHERE id=?1 AND active=1").bind(patch.category).first();
    if (!cat) return err(400, "invalid_event", "That category is not available — pick another one.", { field: "category" });
  }
  const { edit, cover, attrs: attrPatch, seo } = splitPatch(patch as EventPatch);
  // [SAATHUM-CHADHAVA 2026-09-26] Private events are locked to 1 seat, server-side.
  if (attrPatch.visibility === "private") {
    edit.capacity = 1;
  } else if (attrPatch.visibility !== "public") {
    const curAttrs = attrsOf(row.attrs);
    if (curAttrs.visibility === "private" && "capacity" in edit && edit.capacity !== 1) edit.capacity = 1;
  }
  const e1 = await runAdminEdit(req, env, id, edit, exec);
  if (e1) return e1;
  const e2 = await writeMediaAndAttrs(env, a.uid, id, cover, attrPatch);
  if (e2) return e2;
  await refreshSeo(env, a.uid, id, seo);
  safeTrack(env, a.uid, "admin2_event_updated", { listing_id: id, fields: Object.keys(patch).join(",") });
  const out = await detailPayload(env, id, a.uid);
  return json({ ok: true, id, ...(out ?? {}) });
}

/** Make attrs.poster 'approved' from the admin's own choice (see posterPlan()). */
async function ensurePosterApproved(req: Request, env: Env, adminUid: string, id: string, exec: Exec): Promise<Response | null> {
  const row = await loadRow(env, id);
  if (!row) return err(404, "not_found", "No such event.");
  const attrs = attrsOf(row.attrs);
  const plan = posterPlan(attrs, row.cover_media);
  if (plan.kind === "ready") return null;
  if (plan.kind === "needs_image") return err(409, "needs_image", plan.message, { field: "cover_url" });
  if (plan.kind === "approve_ai") {
    const res = await adminListingAction(inner(req, "POST", { action: "approve_poster" }), env, id, exec);
    if (res.ok) return null;
    const b = await readJson(res);
    return json({ ...b, message: b.message ?? "The AI poster could not be approved." }, res.status);
  }
  // use_cover: the admin's uploaded cover IS the reviewed image. attrs.poster is not part
  // of the review hash (reviewedContentHash strips it), so this never stales an approval.
  attrs.poster = {
    ...(attrs.poster && attrs.poster.provider === "admin_cover" ? attrs.poster : {}),
    status: "approved", provider: "admin_cover", url: plan.url, auto: false,
    completed_at: Date.now(), approved_by: adminUid,
  };
  const res = await env.DB_META.prepare(
    "UPDATE listings SET attrs=?2, updated_at=?3 WHERE id=?1 AND authority_version=?4",
  ).bind(id, JSON.stringify(attrs), Date.now(), Number(row.authority_version ?? 0)).run();
  if (!(res.meta?.changes ?? 0)) return err(409, "conflict", "This event changed while publishing. Reload and try again.");
  await history(env, { listingId: id, actorId: adminUid, action: "approve_poster", prev: row.status, next: row.status, reason: "admin_cover", poster: "approved" });
  return null;
}

export async function adminEventPublish(req: Request, env: Env, id: string, exec: Exec): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const row = await loadRow(env, id);
  if (!row || String(row.kind) !== "live_event") return err(404, "not_found", "No such event.");
  const status = String(row.status);
  if (status === "published" || status === "live") return json({ ok: true, id, status, already: true });
  if (!["draft", "pending_review", "approved"].includes(status)) {
    return err(409, "not_publishable", status === "rejected"
      ? "This event was rejected in the old review queue. Duplicate it as a new event instead."
      : `A ${status} event cannot be published.`, { status });
  }
  // listing_blockers first — the single "can this publish" rule set. Nothing is approved
  // unless it would publish.
  const blockers = await listingBlockers(env, row);
  if (blockers.length) {
    safeTrack(env, a.uid, "admin2_event_publish_blocked", { listing_id: id, codes: blockers.map((b) => b.code).join(",") });
    return err(409, "not_publishable", blockers.length === 1 ? blockers[0].message : `${blockers.length} things need fixing before this can go live.`, { blockers, field: blockers[0].field });
  }
  const poster = await ensurePosterApproved(req, env, a.uid, id, exec);
  if (poster) return poster;

  const fresh = await loadRow(env, id);
  if (fresh && String(fresh.status) !== "approved") {
    const ap = await adminListingAction(inner(req, "POST", { action: "approve_listing" }), env, id, exec);
    if (!ap.ok) {
      const b = await readJson(ap);
      return json({ ...b, message: b.message ?? "The event could not be approved." }, ap.status);
    }
  }
  const pub = await adminListingAction(inner(req, "POST", { action: "publish" }), env, id, exec);
  const pb = await readJson(pub);
  if (!pub.ok) {
    safeTrack(env, a.uid, "admin2_event_publish_failed", { listing_id: id, status: pub.status, error: pb.error ?? null });
    // The event stays approved (Drafts tab); every message below is publish's own.
    const msg = pb.message ?? (Array.isArray(pb.blockers) && pb.blockers[0]?.message) ?? pb.detail ?? pb.error ?? "The event could not be published.";
    return json({ ...pb, message: msg }, pub.status);
  }
  safeTrack(env, a.uid, "admin2_event_published", { listing_id: id });
  const out = await detailPayload(env, id, a.uid);
  return json({ ok: true, id, status: "published", ...(out ?? {}) });
}

async function soldCount(env: Env, id: string): Promise<{ seats: number; pending: number; orders: number }> {
  const r = await env.DB_META.prepare(
    `SELECT
       (SELECT COUNT(*) FROM commercial_entitlements ce WHERE ce.listing_id=?1 AND ce.state IN ('reserved','held','active','consumed')) AS seats,
       (SELECT COUNT(*) FROM orders o WHERE o.listing_id=?1 AND o.status IN ('held','free')) AS orders,
       (SELECT COUNT(*) FROM hdfc_sms_payment_intents h WHERE h.listing_id=?1 AND h.commercial_order_id IS NULL
          AND (h.status IN ('payment_received','review_pending') OR (h.status='pending' AND h.expires_at>?2))) AS pending`,
  ).bind(id, Date.now()).first<{ seats: number; orders: number; pending: number }>();
  return { seats: Number(r?.seats ?? 0), orders: Number(r?.orders ?? 0), pending: Number(r?.pending ?? 0) };
}

/**
 * Unpublish = take a published event back to the Drafts tab. Allowed only while
 * nobody has booked or is mid-payment; with bookings the answer is Cancel, which
 * refunds. Uses the table's review-invalidation row (published -> pending_review),
 * the same move updateListing makes when an unsold listing's content changes, and
 * releases the calendar reservation publish made.
 */
export async function adminEventUnpublish(req: Request, env: Env, id: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const row = await loadRow(env, id);
  if (!row || String(row.kind) !== "live_event") return err(404, "not_found", "No such event.");
  if (String(row.status) !== "published") {
    return err(409, "not_published", row.status === "live" ? "This event is live right now. Cancel it instead." : "Only a published event can be unpublished.", { status: row.status });
  }
  const sold = await soldCount(env, id);
  if (sold.seats || sold.orders || sold.pending) {
    return err(409, "has_bookings", "People have booked or are paying for this event. Cancel it instead — that refunds them and tells them why.", sold);
  }
  const check = checkTransition("published", "pending_review", "system");
  if (!check.ok) return err(409, "transition_not_allowed", "This event cannot be unpublished right now.");
  const res = await env.DB_META.prepare(
    `UPDATE listings SET status='pending_review', reviewed_content_hash=NULL, reviewed_at=NULL, reviewed_by=NULL, updated_at=?2
      WHERE id=?1 AND status='published' AND authority_version=?3`,
  ).bind(id, Date.now(), Number(row.authority_version ?? 0)).run();
  if (!(res.meta?.changes ?? 0)) return err(409, "conflict", "This event changed. Reload and try again.");
  await releaseListingReservations(env, String(row.creator_id), id).catch((e) => trackException(env, e, { uid: a.uid, route: "admin2_events.unpublish.release", handled: true, app_name: APP }));
  await releaseBlocks(env, LISTINGS_APP, id).catch(() => undefined);
  await ftsSync(env, id, true).catch(() => undefined);
  await history(env, { listingId: id, actorId: a.uid, action: "admin_unpublish", prev: "published", next: "pending_review", reason: check.rule.id });
  await audit(env, a.uid, "listing_admin_unpublish", id, { previous_status: "published" });
  safeTrack(env, a.uid, "admin2_event_unpublished", { listing_id: id });
  const out = await detailPayload(env, id, a.uid);
  return json({ ok: true, id, status: "pending_review", ...(out ?? {}) });
}

/**
 * Cancel. Published/live: refund every open order FIRST (refundOpenOrdersForListing, the
 * rule creator cancel and admin reject use), and refuse while a UPI payment has arrived
 * but is not yet a booking — that money has no order to refund through, so the admin must
 * settle it in Payments first. Drafts the admin created: plain cancel, nothing was sold.
 */
export async function adminEventCancel(req: Request, env: Env, id: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const b = await readBody(req);
  if (!b || b.confirm !== true) return err(400, "confirm_required", "Confirm the cancellation.");
  const row = await loadRow(env, id);
  if (!row || String(row.kind) !== "live_event") return err(404, "not_found", "No such event.");
  const status = String(row.status);
  const adminCheck = checkTransition(status, "cancelled", "admin");
  const ownCheck = row.creator_id === a.uid ? checkTransition(status, "cancelled", "creator") : adminCheck;
  const check = adminCheck.ok ? adminCheck : ownCheck;
  if (!check.ok) {
    return err(409, "transition_not_allowed", status === "cancelled" ? "This event is already cancelled."
      : status === "completed" ? "This event has already happened." : "This event cannot be cancelled from its current state.", { status });
  }
  let refunds = { scanned: 0, refunded: 0, no_refund: 0, review_pending: 0, failed: 0 };
  if (status === "published" || status === "live") {
    const inFlight = await env.DB_META.prepare(
      `SELECT COUNT(*) AS n FROM hdfc_sms_payment_intents WHERE listing_id=?1 AND commercial_order_id IS NULL
         AND status IN ('payment_received','review_pending')`,
    ).bind(id).first<{ n: number }>();
    if (Number(inFlight?.n ?? 0) > 0) {
      return err(409, "payments_in_flight", `${inFlight!.n} UPI payment${Number(inFlight!.n) === 1 ? " has" : "s have"} arrived for this event but ${Number(inFlight!.n) === 1 ? "is" : "are"} not a booking yet. Settle ${Number(inFlight!.n) === 1 ? "it" : "them"} in Payments, then cancel.`, { in_flight: Number(inFlight!.n) });
    }
    refunds = await refundOpenOrdersForListing(env, id, "listing_cancelled");
    safeTrack(env, a.uid, "admin2_event_cancel_refunds", { listing_id: id, ...refunds });
    if (refunds.failed > 0) {
      return err(503, "refunds_incomplete", "Some tickets could not be refunded yet, so the event is still up. Try again in a minute.", { refunds });
    }
  }
  const res = await env.DB_META.prepare(
    "UPDATE listings SET status='cancelled', updated_at=?2 WHERE id=?1 AND status=?3 AND authority_version=?4",
  ).bind(id, Date.now(), status, Number(row.authority_version ?? 0)).run();
  if (!(res.meta?.changes ?? 0)) return err(409, "conflict", "This event changed. Reload and try again.", { refunds });
  await releaseBlocks(env, LISTINGS_APP, id).catch(() => undefined);
  await releaseListingReservations(env, String(row.creator_id), id).catch((e) => trackException(env, e, { uid: a.uid, route: "admin2_events.cancel.release", handled: true, app_name: APP }));
  await ftsSync(env, id, true).catch(() => undefined);
  await history(env, { listingId: id, actorId: a.uid, action: "admin_cancel", prev: status, next: "cancelled", reason: typeof b.reason === "string" ? b.reason.slice(0, 500) : check.rule.id });
  await audit(env, a.uid, "listing_admin_cancel", id, { previous_status: status, refunds });
  safeTrack(env, a.uid, "admin2_event_cancelled", { listing_id: id, previous_status: status, ...refunds });
  return json({ ok: true, id, status: "cancelled", refunds });
}

/** AI poster: generate (synchronous, like the old admin panel) or keep the generated one. */
export async function adminEventPoster(req: Request, env: Env, id: string, exec: Exec): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const b = await readBody(req);
  const action = String(b?.action ?? "");
  const row = await loadRow(env, id);
  if (!row || String(row.kind) !== "live_event") return err(404, "not_found", "No such event.");
  const attrs = attrsOf(row.attrs);
  let mapped: string;
  if (action === "generate") {
    mapped = !attrs.poster || attrs.poster.provider === "admin_cover" ? "generate_poster" : "regenerate_poster";
    // An admin-cover "poster" is not a generated image; clear it so generation can run.
    if (attrs.poster?.provider === "admin_cover") {
      delete attrs.poster;
      await env.DB_META.prepare("UPDATE listings SET attrs=?2 WHERE id=?1 AND authority_version=?3")
        .bind(id, JSON.stringify(attrs), Number(row.authority_version ?? 0)).run();
    }
  } else if (action === "keep") mapped = "approve_poster";
  else return err(400, "invalid_action", "Send {action:'generate'|'keep'}.");
  const res = await adminListingAction(inner(req, "POST", { action: mapped }), env, id, exec);
  const rb = await readJson(res);
  if (!res.ok) return json({ ...rb, message: rb.message ?? rb.error ?? "The poster action failed." }, res.status);
  safeTrack(env, a.uid, "admin2_event_poster", { listing_id: id, action, poster_status: rb.poster?.status ?? null });
  const out = await detailPayload(env, id, a.uid);
  return json({ ok: true, id, ...(out ?? {}) });
}

// ---------------------------------------------------------------------------
// Route table — spread into ADMIN2_ROUTES in routes/admin2.ts ("events (agent B)").
// The dispatcher there URI-decodes the capture groups and wraps every handler in
// trackException. Its handlers get no ExecutionContext, so the ad-hook work the
// approve action queues runs as a detached promise (best-effort, as it is documented).
// ---------------------------------------------------------------------------
const ID = "([^/]+)";
export const ADMIN2_EVENT_ROUTES: Admin2RouteDef[] = [
  { method: "GET", path: "/api/admin/v2/events", handler: (req, env) => adminEventsList(req, env) },
  { method: "POST", path: "/api/admin/v2/events", handler: (req, env) => adminEventCreate(req, env, undefined) },
  { method: "GET", path: "/api/admin/v2/events/meta", handler: (req, env) => adminEventsMeta(req, env) },
  { method: "GET", path: new RegExp(`^/api/admin/v2/events/${ID}$`), handler: (req, env, [id]) => adminEventDetail(req, env, id) },
  { method: "PUT", path: new RegExp(`^/api/admin/v2/events/${ID}$`), handler: (req, env, [id]) => adminEventUpdate(req, env, id, undefined) },
  { method: "POST", path: new RegExp(`^/api/admin/v2/events/${ID}/publish$`), handler: (req, env, [id]) => adminEventPublish(req, env, id, undefined) },
  { method: "POST", path: new RegExp(`^/api/admin/v2/events/${ID}/unpublish$`), handler: (req, env, [id]) => adminEventUnpublish(req, env, id) },
  { method: "POST", path: new RegExp(`^/api/admin/v2/events/${ID}/cancel$`), handler: (req, env, [id]) => adminEventCancel(req, env, id) },
  { method: "POST", path: new RegExp(`^/api/admin/v2/events/${ID}/poster$`), handler: (req, env, [id]) => adminEventPoster(req, env, id, undefined) },
];
