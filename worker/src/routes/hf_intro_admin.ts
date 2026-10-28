// [HF-INTRO-W1] HF-INTRO-VIDEO-1 D12 / D13: admin review of influencer submissions (ADMIN_UIDS only). Flag hfIntroOnboardingEnabled (off -> 404 not_enabled).
//   GET  /api/admin/hf/intro-applications?status=submitted|approved|rejected   -> { ok, items:[row], rejectReasons:[{code,text}] }
//   GET  /api/admin/hf/intro-applications/:id                                  -> { ok, application, host, video, socials, aadhaar, calendar, history }
//   POST /api/admin/hf/intro-applications/:id/approve                           -> { ok, status:'approved', notified }   (host goes live, reel appears)
//   POST /api/admin/hf/intro-applications/:id/reject  { reasons[], note? }      -> { ok, status:'rejected', notified }   (WhatsApp lists the reasons)
// A person watches EVERY submission (D1); there is no automatic approval. Contract: Specs/HF-INTRO-VIDEO-1-API.md.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackUser, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { emailFor } from "../lib/identity";
import { isAdminUid } from "../lib/preview";
import { sendWhatsAppText } from "../lib/whatsapp_send";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { pushHostDecision } from "../lib/hf_push";
import { getHost, ensureSlug, mediaUrl } from "../lib/hf_host_store";
import { validCreatorRate } from "../lib/hf_creator_pricing";
import { getHfBookingSchedule } from "../lib/hf_booking_store";
import { categoriesFromJson, WOMEN_TO_WOMEN } from "../lib/hf_categories";
import { APPLICATION_ID_RE, REJECT_REASONS, REJECT_REASON_CODES, GATE_MESSAGES, submissionGate, approvedMessage, rejectedMessage } from "../lib/hf_intro_video";
import { readConfig } from "./config";
import { onboardingFacts, applicationJson, videoJson, parseJsonArray, type AppRow, type VideoRow } from "./hf_intro_onboarding";

const APP = BRAND.slug;
const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ ok: false, error, message: error, ...extra }, status, NO_STORE);
const STATUSES = ["submitted", "approved", "rejected"];
const rejectReasonList = () => REJECT_REASON_CODES.map((code) => ({ code, text: REJECT_REASONS[code] }));

async function adminCtx(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  if (!isAdminUid(env, u.uid)) return err(403, "forbidden");
  return { uid: u.uid };
}
async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 8_000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

async function audit(env: Env, adminUid: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), adminUid, `hf_intro_${action}`, target, JSON.stringify(meta), Date.now()).run();
  } catch (e) {
    await trackException(env, e, { route: "/api/admin/hf/intro-applications", handled: true, app_name: APP, extra: { area: "hf_intro_admin", step: "admin_audit", action } });
  }
}

/** Telemetry for the reviewer's action: the event belongs to the reviewer (email + clerk_uid) and names the influencer. */
async function emit(env: Env, adminUid: string, event: string, props: Record<string, unknown>): Promise<void> {
  try {
    const email = await emailFor(env, adminUid).catch(() => null);
    await trackUser(env, adminUid, email, event, APP, { area: "hf_intro_admin", clerk_uid: adminUid, ...props });
  } catch (e) {
    await trackException(env, e, { uid: adminUid, route: "/api/admin/hf/intro-applications", handled: true, app_name: APP, extra: { area: "hf_intro_admin", step: "telemetry", event } });
  }
}

/** WhatsApp the influencer about the decision (D13). Never throws; `reason` explains a miss. */
async function notifyInfluencer(env: Env, adminUid: string, uid: string, decision: "approve" | "reject", text: string, applicationId: string): Promise<{ sent: boolean; reason: string | null }> {
  let out: { sent: boolean; reason: string | null } = { sent: false, reason: "no_number" };
  try {
    const phone = await verifiedWhatsAppNumber(env, uid);
    if (phone) {
      const r = await sendWhatsAppText(env, phone, text);
      out = r.ok ? { sent: true, reason: null } : { sent: false, reason: r.reason };
    }
  } catch (e) {
    out = { sent: false, reason: "error" };
    await trackException(env, e, { uid: adminUid, route: "/api/admin/hf/intro-applications", handled: true, app_name: APP, extra: { area: "hf_intro_admin", step: "whatsapp" } });
  }
  await emit(env, adminUid, "hf_review_whatsapp", { decision, ok: out.sent, reason: out.reason, application_id: applicationId, influencer_uid: uid });
  return out;
}

async function list(req: Request, env: Env): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const st = new URL(req.url).searchParams.get("status") || "submitted";
  if (!STATUSES.includes(st)) return err(400, "bad_status");
  const rows = (await env.DB_META.prepare(
    `SELECT a.id, a.uid, a.status, a.categories_json, a.lang, a.call_option, a.rate_rupees, a.has_socials, a.aadhaar_ok, a.submitted_at, a.reviewed_at,
            h.display_name AS name, k.gender AS aadhaar_gender
       FROM hf_influencer_applications a LEFT JOIN hf_hosts h ON h.uid=a.uid LEFT JOIN hf_kyc k ON k.uid=a.uid AND k.verified_at IS NOT NULL
      WHERE a.status=?1 ORDER BY ${st === "submitted" ? "a.submitted_at ASC" : "a.reviewed_at DESC"}, a.id ASC LIMIT 100`,
  ).bind(st).all<{ id: string; uid: string; status: string; categories_json: string; lang: string | null; call_option: string; rate_rupees: number | null; has_socials: number; aadhaar_ok: number; submitted_at: number; reviewed_at: number | null; name: string | null; aadhaar_gender: string | null }>()).results ?? [];
  return json({
    ok: true,
    items: rows.map((r) => ({
      id: r.id, uid: r.uid, status: r.status, name: r.name ?? "", categories: categoriesFromJson(r.categories_json), lang: r.lang, ratePerMin: r.rate_rupees, callOption: r.call_option,
      submittedAt: r.submitted_at, reviewedAt: r.reviewed_at, hasSocials: r.has_socials === 1,
      aadhaar: { status: r.aadhaar_ok === 1 || r.aadhaar_gender ? "verified" : "none", female: r.aadhaar_gender === "F" },
    })),
    rejectReasons: rejectReasonList(),
  }, 200, NO_STORE);
}

async function detail(req: Request, env: Env, id: string): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const app = await env.DB_META.prepare("SELECT * FROM hf_influencer_applications WHERE id=?1").bind(id).first<AppRow>();
  if (!app) return err(404, "not_found");
  const [host, video, facts, history, photo] = await Promise.all([
    getHost(env, app.uid),
    env.DB_META.prepare("SELECT * FROM hf_intro_videos WHERE id=?1").bind(app.intro_video_id).first<VideoRow>(),
    onboardingFacts(env, app.uid),
    env.DB_META.prepare("SELECT * FROM hf_influencer_applications WHERE uid=?1 AND id<>?2 ORDER BY submitted_at DESC LIMIT 5").bind(app.uid, id).all<AppRow>(),
    env.DB_META.prepare("SELECT r2_key FROM hf_host_media WHERE uid=?1 AND kind='profile' AND status='active' ORDER BY created_at DESC LIMIT 1").bind(app.uid).first<{ r2_key: string }>(),
  ]);
  let calendar: Record<string, unknown> | null = null;
  try {
    const s = await getHfBookingSchedule(env, app.uid);
    const days: Record<number, { startMin: number; endMin: number }[]> = {};
    for (const r of s.rules) (days[r.weekday] ??= []).push({ startMin: r.startMin, endMin: r.endMin });
    calendar = { timezone: s.timezone, weekly: Object.entries(days).map(([weekday, ranges]) => ({ weekday: Number(weekday), ranges })), exceptions: s.exceptions.length, empty: s.rules.length === 0 };
  } catch (e) {
    await trackException(env, e, { uid: a.uid, route: "/api/admin/hf/intro-applications", handled: true, app_name: APP, extra: { area: "hf_intro_admin", step: "calendar" } });
  }
  await audit(env, a.uid, "view", id, { uid: app.uid });
  return json({
    ok: true,
    application: applicationJson(app),
    host: host ? { uid: host.uid, status: host.status, name: host.display_name, description: host.about, ratePerMin: host.price_per_min, photoUrl: photo ? mediaUrl(env, photo.r2_key) : null, callOption: app.call_option } : null,
    video: video ? videoJson(env, video) : null,
    socials: facts.socials.map((s) => ({ platform: s.platform, handle: s.handle, url: s.url, followers: s.followers })),
    aadhaar: { done: facts.aadhaarDone, female: facts.aadhaarGender === "F", gender: facts.aadhaarGender },
    whatsappVerified: facts.whatsappVerified,
    womenToWomen: categoriesFromJson(app.categories_json).some((c) => c.id === WOMEN_TO_WOMEN),
    calendar,
    history: (history.results ?? []).map(applicationJson),
    rejectReasons: rejectReasonList(),
  }, 200, NO_STORE);
}

async function approve(req: Request, env: Env, id: string): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const app = await env.DB_META.prepare("SELECT * FROM hf_influencer_applications WHERE id=?1").bind(id).first<AppRow>();
  if (!app) return err(404, "not_found");
  if (app.status !== "submitted") return err(409, "bad_state", { status: app.status });
  const uid = app.uid;
  const [host, video, facts] = await Promise.all([
    getHost(env, uid),
    env.DB_META.prepare("SELECT * FROM hf_intro_videos WHERE id=?1 AND uid=?2").bind(app.intro_video_id, uid).first<VideoRow>(),
    onboardingFacts(env, uid),
  ]);
  if (!host) return err(409, "no_host");
  if (!video) return err(409, "video_missing");
  if (host.status === "paused" || host.status === "archived") return err(409, "host_not_eligible", { status: host.status, message: "This profile is paused or closed." });
  // Re-check at approval time: things can change between submit and review (D4).
  const missing: string[] = [];
  if (!host.display_name) missing.push("name");
  if (!validCreatorRate(host.price_per_min)) missing.push("rate");
  if (!facts.whatsappVerified) missing.push("whatsapp");
  if (missing.length) return err(409, "not_ready", { missing });
  const cats = categoriesFromJson(app.categories_json).map((c) => c.id);
  const gate = submissionGate({ categories: cats, hasVerifiedSocial: facts.socials.length > 0, aadhaarDone: facts.aadhaarDone, aadhaarGender: facts.aadhaarGender });
  if (gate) return err(409, gate, { message: GATE_MESSAGES[gate] });
  const slug = host.slug || (await ensureSlug(env, uid, host.display_name!));
  if (!slug) return err(500, "slug_failed");
  const now = Date.now();
  const women = cats.includes(WOMEN_TO_WOMEN) ? 1 : 0;
  const guard = "EXISTS (SELECT 1 FROM hf_influencer_applications WHERE id=?1 AND status='approved' AND reviewed_at=?2 AND reviewer_uid=?3)";
  const res = await env.DB_META.batch([
    env.DB_META.prepare("UPDATE hf_influencer_applications SET status='approved', reviewed_at=?2, reviewer_uid=?3 WHERE id=?1 AND status='submitted'").bind(id, now, a.uid),
    env.DB_META.prepare(`UPDATE hf_intro_videos SET status='replaced', updated_at=?2 WHERE uid=?4 AND status='approved' AND id<>?5 AND ${guard}`).bind(id, now, a.uid, uid, app.intro_video_id),
    env.DB_META.prepare(`UPDATE hf_intro_videos SET status='approved', updated_at=?2 WHERE id=?4 AND ${guard}`).bind(id, now, a.uid, app.intro_video_id),
    env.DB_META.prepare(
      `UPDATE hf_hosts SET status=CASE WHEN status IN ('approved','live') THEN status ELSE 'live' END,
         presence=CASE WHEN status IN ('approved','live') THEN presence ELSE 'online' END, presence_at=CASE WHEN status IN ('approved','live') THEN presence_at ELSE ?2 END,
         live_at=COALESCE(live_at, ?2), categories_json=?4, call_option=?5, intro_video_id=?6, intro_approved_at=?2, women_lane=CASE WHEN ?7=1 THEN 1 ELSE women_lane END,
         review_note=NULL, reviewed_by=?3, reviewed_at=?2, updated_at=?2, listing_revision=listing_revision+1
       WHERE uid=?8 AND ${guard}`,
    ).bind(id, now, a.uid, app.categories_json, app.call_option, app.intro_video_id, women, uid),
  ]);
  if (!res[0]?.meta?.changes) return err(409, "bad_state", { message: "Someone else just decided on this." });
  await audit(env, a.uid, "approve", id, { uid });
  const notified = await notifyInfluencer(env, a.uid, uid, "approve", approvedMessage(host.display_name), id);
  await pushHostDecision(env, undefined, uid, "approve").catch((e) => trackException(env, e, { uid: a.uid, route: "/api/admin/hf/intro-applications", handled: true, app_name: APP, extra: { area: "hf_intro_admin", step: "push" } }));
  await emit(env, a.uid, "hf_admin_review", { decision: "approve", reasons: "", application_id: id, influencer_uid: uid, women_to_women: women === 1 });
  return json({ ok: true, status: "approved", notified: notified.sent, notifyReason: notified.reason }, 200, NO_STORE);
}

async function reject(req: Request, env: Env, id: string): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const b = await readJson(req);
  const reasons = Array.isArray(b.reasons) ? [...new Set(b.reasons.filter((r): r is string => typeof r === "string"))] : [];
  if (!reasons.length || reasons.length > REJECT_REASON_CODES.length || !reasons.every((r) => REJECT_REASON_CODES.includes(r))) return err(400, "invalid_field", { field: "reasons", message: "Pick at least one reason from the list." });
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 500) : "";
  if (reasons.includes("other") && !note) return err(400, "note_required", { field: "note", message: "Please write a short note when the reason is Other." });
  const app = await env.DB_META.prepare("SELECT * FROM hf_influencer_applications WHERE id=?1").bind(id).first<AppRow>();
  if (!app) return err(404, "not_found");
  if (app.status !== "submitted") return err(409, "bad_state", { status: app.status });
  const now = Date.now();
  const guard = "EXISTS (SELECT 1 FROM hf_influencer_applications WHERE id=?1 AND status='rejected' AND reviewed_at=?2 AND reviewer_uid=?3)";
  const res = await env.DB_META.batch([
    env.DB_META.prepare("UPDATE hf_influencer_applications SET status='rejected', reviewed_at=?2, reviewer_uid=?3, reject_reasons_json=?4, reject_note=?5 WHERE id=?1 AND status='submitted'")
      .bind(id, now, a.uid, JSON.stringify(reasons), note || null),
    env.DB_META.prepare(`UPDATE hf_intro_videos SET status='rejected', updated_at=?2 WHERE id=?4 AND ${guard}`).bind(id, now, a.uid, app.intro_video_id),
  ]);
  if (!res[0]?.meta?.changes) return err(409, "bad_state", { message: "Someone else just decided on this." });
  const host = await getHost(env, app.uid);
  await audit(env, a.uid, "reject", id, { uid: app.uid, reasons, note });
  const notified = await notifyInfluencer(env, a.uid, app.uid, "reject", rejectedMessage(reasons, note), id);
  await pushHostDecision(env, undefined, app.uid, "reject").catch((e) => trackException(env, e, { uid: a.uid, route: "/api/admin/hf/intro-applications", handled: true, app_name: APP, extra: { area: "hf_intro_admin", step: "push" } }));
  await emit(env, a.uid, "hf_admin_review", { decision: "reject", reasons: reasons.join(","), application_id: id, influencer_uid: app.uid, host_status: host?.status ?? null });
  return json({ ok: true, status: "rejected", notified: notified.sent, notifyReason: notified.reason }, 200, NO_STORE);
}

/** Returns null when the path is not ours so index.ts can fall through. */
export async function hfIntroAdminRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  if (p !== "/api/admin/hf/intro-applications" && !p.startsWith("/api/admin/hf/intro-applications/")) return null;
  const m = req.method;
  const one = p.match(/^\/api\/admin\/hf\/intro-applications\/(hfia_[a-f0-9]{20})$/);
  const act = p.match(/^\/api\/admin\/hf\/intro-applications\/(hfia_[a-f0-9]{20})\/(approve|reject)$/);
  const ours = (p === "/api/admin/hf/intro-applications" && m === "GET") || (!!one && m === "GET") || (!!act && m === "POST");
  if (!ours) return null;
  try {
    if ((await readConfig(env)).hfIntroOnboardingEnabled !== true) return err(404, "not_enabled");
    if (p === "/api/admin/hf/intro-applications") return await list(req, env);
    if (one) return await detail(req, env, one[1]);
    const id = act![1];
    if (!APPLICATION_ID_RE.test(id)) return err(400, "bad_id");
    return act![2] === "approve" ? await approve(req, env, id) : await reject(req, env, id);
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: APP, extra: { area: "hf_intro_admin" } });
    return err(500, "internal");
  }
}
