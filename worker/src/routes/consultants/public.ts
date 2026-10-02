// [AUMFE-CONSULT-W1-1 2026-10-02] Real Consultants — public read API (lane W1). Visibility rules:
//   * flag consultantsEnabled OFF  -> only previewers see anything (draft + live); everyone else gets an empty list / 404
//   * flag ON                      -> everyone sees `live` only
// Seed reviews are previewer-only and flagged `sample_reviews: true`. Spec: Specs/SPEC-2026-10-02-REAL-CONSULTANTS-BUILD.md
import type { Env } from "../../types";
import { json } from "../../util";
import { BRAND } from "../../lib/brand";
import { metaDb } from "../../db/shard";
import { requireUser, isFail } from "../../authz";
import { readConfig } from "../config";
import { track, trackException } from "../../hooks";
import { consultVisible, seesSeed } from "../../lib/consultants/access";
import { isPreviewer } from "../../lib/preview";
import { consultantBySlug, ratingFor, toCard, toDetail, type ConsultantRow } from "../../lib/consultants/store";
import { loadSchedules, nextFreeMs, slotDays } from "../../lib/consultants/schedule";
import { visibleStatuses } from "../../lib/consultants/booking_logic";
import { istDate, istMidnight } from "../../lib/consultants/slots";
import type { ReviewDTO, Discipline } from "../../lib/consultants/types";

const APP = BRAND.slug;
const PAGE = 5;
const DAY = 86_400_000;
const MAX_DAYS = 62;

/** Signed-in uid when a valid token came with the request; null for anonymous / bad token (these routes are public). */
async function optionalUid(req: Request, env: Env): Promise<string | null> {
  if (!req.headers.get("authorization")) return null;
  const u = await requireUser(req, env);
  return isFail(u) ? null : u.uid;
}

/** Anything a previewer or a signed-in user may see differently is never shared-cached. */
function cacheFor(req: Request, previewer: boolean): Record<string, string> {
  if (previewer) return { "cache-control": "private, no-store" };
  return req.headers.get("authorization") ? { "cache-control": "private, max-age=30" } : { "cache-control": "public, max-age=30" };
}

interface Viewer { uid: string | null; previewer: boolean; isPublic: boolean; visible: boolean; statuses: ("live" | "draft")[]; seed: boolean }
async function viewerOf(req: Request, env: Env): Promise<Viewer> {
  const uid = await optionalUid(req, env);
  const [visible, cfg] = await Promise.all([consultVisible(env, uid), readConfig(env)]);
  const isPublic = cfg.consultantsEnabled === true;
  const previewer = !!uid && isPreviewer(env, uid);
  return { uid, previewer, isPublic, visible, statuses: visible ? visibleStatuses(isPublic, previewer) : [], seed: seesSeed(env, uid) };
}

async function visibleConsultant(env: Env, v: Viewer, slug: string): Promise<ConsultantRow | null> {
  if (!v.visible || !/^[a-z0-9][a-z0-9_-]{0,80}$/.test(slug)) return null;
  const c = await consultantBySlug(env, slug);
  return c && (v.statuses as string[]).includes(c.status) ? c : null;
}

const rating = (env: Env, id: string, v: Viewer) => ratingFor(env, id, v.seed);

async function listRoute(req: Request, env: Env): Promise<Response> {
  const v = await viewerOf(req, env);
  const uid = v.uid ?? "anon";
  if (!v.statuses.length) { void track(env, uid, "consult_list_viewed", APP, { ok: true, count: 0, gated: true }); return json({ consultants: [] }, 200, cacheFor(req, v.previewer)); }
  const rows = await metaDb(env).prepare(
    `SELECT * FROM consultants WHERE status IN (${v.statuses.map((_, i) => `?${i + 1}`).join(",")}) ORDER BY sort_order ASC, name ASC LIMIT 60`,
  ).bind(...v.statuses).all<ConsultantRow>();
  const list = rows.results ?? [];
  const now = Date.now();
  const [ratings, schedules] = await Promise.all([
    Promise.all(list.map((c) => rating(env, c.id, v))),
    loadSchedules(env, list.map((c) => c.id), now, now + 15 * DAY, now),
  ]);
  const consultants = list.map((c, i) => toCard(c, {
    ...ratings[i], next_free_ms: nextFreeMs(schedules.get(c.id)!, c.slot_minutes, c.buffer_minutes, now),
  }));
  void track(env, uid, "consult_list_viewed", APP, { ok: true, count: consultants.length });
  return json({ consultants }, 200, cacheFor(req, v.previewer));
}

async function reviewPage(env: Env, v: Viewer, consultantId: string, page: number): Promise<{ reviews: ReviewDTO[]; pages: number; sample: boolean }> {
  const db = metaDb(env);
  const seedCond = v.seed ? "" : "AND seed=0";
  const [tot, rows, seeds] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM consult_reviews WHERE consultant_id=?1 AND status='approved' ${seedCond}`).bind(consultantId).first<{ n: number }>(),
    db.prepare(
      `SELECT id, stars, text, display_name, discipline, created_at FROM consult_reviews
        WHERE consultant_id=?1 AND status='approved' ${seedCond} ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3`,
    ).bind(consultantId, PAGE, (page - 1) * PAGE).all<{ id: string; stars: number; text: string | null; display_name: string; discipline: Discipline; created_at: number }>(),
    v.seed
      ? db.prepare(`SELECT COUNT(*) AS n FROM consult_reviews WHERE consultant_id=?1 AND status='approved' AND seed=1`).bind(consultantId).first<{ n: number }>()
      : Promise.resolve({ n: 0 }),
  ]);
  return {
    reviews: (rows.results ?? []).map((r) => ({ id: r.id, stars: r.stars, text: r.text, display_name: r.display_name, discipline: r.discipline, created_at: r.created_at })),
    pages: Math.max(1, Math.ceil(Number(tot?.n || 0) / PAGE)),
    sample: Number(seeds?.n || 0) > 0,
  };
}

async function detailRoute(req: Request, env: Env, slug: string): Promise<Response> {
  const v = await viewerOf(req, env);
  const c = await visibleConsultant(env, v, slug);
  if (!c) { void track(env, v.uid ?? "anon", "consult_page_viewed", APP, { ok: false, reason: "not_found" }); return json({ error: "not_found" }, 404, cacheFor(req, v.previewer)); }
  const now = Date.now();
  const [r, sched, rp] = await Promise.all([
    rating(env, c.id, v), loadSchedules(env, [c.id], now, now + 15 * DAY, now), reviewPage(env, v, c.id, 1),
  ]);
  const consultant = toDetail(c, { ...r, next_free_ms: nextFreeMs(sched.get(c.id)!, c.slot_minutes, c.buffer_minutes, now) });
  void track(env, v.uid ?? "anon", "consult_page_viewed", APP, { ok: true, slug, status: c.status });
  return json({ consultant, reviews: rp.reviews, review_pages: rp.pages, sample_reviews: rp.sample }, 200, cacheFor(req, v.previewer));
}

async function reviewsRoute(req: Request, env: Env, slug: string): Promise<Response> {
  const v = await viewerOf(req, env);
  const c = await visibleConsultant(env, v, slug);
  if (!c) return json({ error: "not_found" }, 404, cacheFor(req, v.previewer));
  const raw = Number(new URL(req.url).searchParams.get("page") ?? "1");
  const page = Number.isInteger(raw) && raw >= 1 && raw <= 1000 ? raw : 1;
  const rp = await reviewPage(env, v, c.id, page);
  return json({ reviews: rp.reviews, page, pages: rp.pages, sample_reviews: rp.sample }, 200, cacheFor(req, v.previewer));
}

async function slotsRoute(req: Request, env: Env, slug: string): Promise<Response> {
  const v = await viewerOf(req, env);
  const c = await visibleConsultant(env, v, slug);
  if (!c) return json({ error: "not_found" }, 404, cacheFor(req, v.previewer));
  const q = new URL(req.url).searchParams;
  const now = Date.now();
  const today = istDate(now);
  let from = q.get("from") ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || istDate(istMidnight(from) + 12 * 3600e3) !== from) return json({ error: "invalid_from" }, 400);
  if (from < today) from = today;
  const d = Number(q.get("days") ?? "31");
  const days = Number.isInteger(d) ? Math.min(MAX_DAYS, Math.max(1, d)) : 31;
  const sched = await loadSchedules(env, [c.id], istMidnight(from), istMidnight(from) + days * DAY, now);
  return json({ days: slotDays(sched.get(c.id)!, from, days, c.slot_minutes, c.buffer_minutes, now) }, 200, cacheFor(req, v.previewer));
}

export async function publicRoutes(req: Request, env: Env, p: string, _ctx?: ExecutionContext): Promise<Response | null> {
  if (req.method !== "GET") return null;
  try {
    if (p === "/api/consultants/list") return await listRoute(req, env);
    const m = /^\/api\/consultants\/c\/([^/]+)(?:\/(reviews|slots))?$/.exec(p);
    if (!m) return null;
    let slug: string;
    try { slug = decodeURIComponent(m[1]); } catch { return json({ error: "not_found" }, 404); }
    if (!m[2]) return await detailRoute(req, env, slug);
    return m[2] === "reviews" ? await reviewsRoute(req, env, slug) : await slotsRoute(req, env, slug);
  } catch (err) {
    await trackException(env, err, { route: p, method: req.method, handled: true, app_name: APP, extra: { area: "consult_public" } });
    return json({ error: "internal", message: "Something went wrong. Please try again." }, 500);
  }
}
