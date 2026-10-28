// [HF-INTRO-W1] HF-INTRO-VIDEO-1: influencer onboarding with a recorded intro video and human approval (rulebook section 20). Flag hfIntroOnboardingEnabled (off -> 404 not_enabled).
//   GET  /api/hf/onboarding/categories            -> { ok, categories:[{id,label,sensitive}], langs:[...], callOptions }       (public)
//   GET  /api/hf/onboarding/me                    -> { ok, host, video, application, requirements, socials }                   (signed in)
//   POST /api/hf/onboarding/intro-video           raw video body (video/mp4|webm) + x-duration-ms, x-video-width, x-video-height [, x-lang, x-topic] -> { ok, video }
//   PUT  /api/hf/onboarding/intro-video/:id/poster raw image body (jpeg|png|webp, <= 2 MB)                                      -> { ok, video }
//   POST /api/hf/onboarding/submit                { categories[], lang, intro_video_id, call_option:'A'|'B', topic? }            -> { ok, application }
// Contract: Specs/HF-INTRO-VIDEO-1-API.md. Nobody is live until a person approves (routes/hf_intro_admin.ts). No AI check of the video (D1).
import type { Env } from "../types";
import { json } from "../util";
import { faststartMp4 } from "../lib/mp4_faststart";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackUser, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { emailFor } from "../lib/identity";
import { readConfig } from "./config";
import { deleteIntroVideoFiles, type IntroFileRow } from "../lib/hf_intro_cleanup";
import { getHost, mediaUrl } from "../lib/hf_host_store";
import { validCreatorRate } from "../lib/hf_creator_pricing";
import { isPhoneVerified } from "../lib/hf_public_verification";
import { publicChannels } from "../lib/hf_public_channels";
import { HF_CATEGORIES, normalizeCategories, isSensitiveCategory, isCategoryId, categoriesFromJson } from "../lib/hf_categories";
import {
  INTRO_VIDEO_MAX_BYTES, INTRO_POSTER_MAX_BYTES, INTRO_LANGS, INTRO_VIDEO_ID_RE, isIntroLang, isCallOption, validateIntroVideo, validateIntroPoster,
  newIntroVideoId, newApplicationId, submissionGate, aadhaarNeeded, GATE_MESSAGES, REJECT_REASONS,
} from "../lib/hf_intro_video";

const APP = BRAND.slug;
const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ ok: false, error, message: error, ...extra }, status, NO_STORE);
const IMMUTABLE = "public, max-age=31536000, immutable";
export const SUBMITTED_MESSAGE = "Sent for approval. A person from our team will check your profile. Once approved you can receive calls.";

export interface VideoRow {
  id: string; uid: string; r2_key: string; poster_key: string | null; mime: string; bytes: number; duration_ms: number; width: number; height: number;
  lang: string | null; topic: string | null; views: number; status: string; created_at: number; updated_at: number;
  /** [HF-INTRO-DELETE-1] set when the files were removed from storage (r2_key is then '' and poster_key NULL). */
  deleted_at?: number | null; deleted_reason?: string | null;
}
export interface AppRow {
  id: string; uid: string; status: string; categories_json: string; lang: string | null; intro_video_id: string; call_option: string; rate_rupees: number | null;
  has_socials: number; aadhaar_ok: number; submitted_at: number; reviewed_at: number | null; reviewer_uid: string | null; reject_reasons_json: string | null; reject_note: string | null;
}

export const videoJson = (env: Env, v: VideoRow) => {
  const gone = !!v.deleted_at || !v.r2_key; // [HF-INTRO-DELETE-1] no URL once the files are deleted
  return {
    id: v.id, status: v.status, videoUrl: gone ? null : mediaUrl(env, v.r2_key), posterUrl: !gone && v.poster_key ? mediaUrl(env, v.poster_key) : null,
    durationMs: v.duration_ms, width: v.width, height: v.height, lang: v.lang, topic: v.topic, createdAt: v.created_at,
    deletedAt: v.deleted_at ?? null, deletedReason: v.deleted_reason ?? null,
  };
};
export const parseJsonArray = (s: unknown): string[] => { try { const v = JSON.parse(String(s ?? "[]")); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };
export const applicationJson = (a: AppRow) => ({
  id: a.id, status: a.status, categories: categoriesFromJson(a.categories_json), lang: a.lang, introVideoId: a.intro_video_id, callOption: a.call_option,
  submittedAt: a.submitted_at, reviewedAt: a.reviewed_at,
  rejectReasons: parseJsonArray(a.reject_reasons_json).map((code) => ({ code, text: REJECT_REASONS[code] ?? code })), rejectNote: a.reject_note,
});

/** The caller's Aadhaar + verified social facts used by the D4 rule. Exported for the admin detail and tests. */
export async function onboardingFacts(env: Env, uid: string): Promise<{ aadhaarDone: boolean; aadhaarGender: string | null; socials: Awaited<ReturnType<typeof publicChannels>>; whatsappVerified: boolean }> {
  const [k, socials, wa] = await Promise.all([
    env.DB_META.prepare("SELECT gender, verified_at FROM hf_kyc WHERE uid=?1").bind(uid).first<{ gender: string | null; verified_at: number | null }>(),
    publicChannels(env, uid),
    isPhoneVerified(env, uid),
  ]);
  return { aadhaarDone: !!k?.verified_at, aadhaarGender: k?.gender === "F" || k?.gender === "M" || k?.gender === "T" ? k.gender : null, socials, whatsappVerified: wa };
}

async function boundedBytes(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const buf = new Uint8Array(await req.arrayBuffer());
  return buf.byteLength > max ? null : buf;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 8_000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

function makeEmit(env: Env, ctx: ExecutionContext | undefined, uid: string) {
  return (event: string, props: Record<string, unknown> = {}): void => {
    const p = (async () => {
      const email = await emailFor(env, uid).catch(() => null);
      await trackUser(env, uid, email, event, APP, { area: "hf_intro_onboarding", clerk_uid: uid, ...props });
    })().catch(async (e) => { await trackException(env, e, { uid, route: "/api/hf/onboarding", handled: true, app_name: APP, extra: { area: "hf_intro_onboarding", step: "telemetry", event } }).catch(() => undefined); });
    if (ctx) ctx.waitUntil(p);
  };
}

async function enabled(env: Env): Promise<boolean> {
  return (await readConfig(env)).hfIntroOnboardingEnabled === true;
}

// ── GET categories ────────────────────────────────────────────────────────────────────────────────────────────
function categories(): Response {
  return json({
    ok: true,
    categories: HF_CATEGORIES.map((c) => ({ id: c.id, label: c.label, sensitive: c.sensitive })),
    langs: INTRO_LANGS,
    callOptions: [{ id: "A", label: "Bookings only" }, { id: "B", label: "Bookings + live" }],
    video: { minSeconds: 10, maxSeconds: 20, portraitOnly: true },
  }, 200, { "cache-control": "public, max-age=300" });
}

// ── GET me ────────────────────────────────────────────────────────────────────────────────────────────────────
async function me(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const uid = u.uid;
  const [host, video, app, facts, photo] = await Promise.all([
    getHost(env, uid),
    env.DB_META.prepare("SELECT * FROM hf_intro_videos WHERE uid=?1 AND status NOT IN ('replaced','expired') AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1").bind(uid).first<VideoRow>(),
    env.DB_META.prepare("SELECT * FROM hf_influencer_applications WHERE uid=?1 ORDER BY submitted_at DESC, id DESC LIMIT 1").bind(uid).first<AppRow>(),
    onboardingFacts(env, uid),
    env.DB_META.prepare("SELECT r2_key FROM hf_host_media WHERE uid=?1 AND kind='profile' AND status='active' ORDER BY created_at DESC LIMIT 1").bind(uid).first<{ r2_key: string }>(),
  ]);
  return json({
    ok: true,
    host: host ? {
      status: host.status, displayName: host.display_name, about: host.about, ratePerMin: host.price_per_min, photoUrl: photo ? mediaUrl(env, photo.r2_key) : null,
      callOption: host.call_option ?? null, introApprovedAt: host.intro_approved_at ?? null,
    } : null,
    video: video ? videoJson(env, video) : null,
    application: app ? applicationJson(app) : null,
    requirements: {
      whatsappVerified: facts.whatsappVerified, aadhaarDone: facts.aadhaarDone, aadhaarGender: facts.aadhaarGender, hasVerifiedSocial: facts.socials.length > 0,
      aadhaarNeededWithoutSensitive: aadhaarNeeded([], facts.socials.length > 0),
    },
    socials: facts.socials.map((s) => ({ platform: s.platform, handle: s.handle, url: s.url })),
  }, 200, NO_STORE);
}

// ── POST intro-video ──────────────────────────────────────────────────────────────────────────────────────────
async function uploadVideo(req: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const uid = u.uid;
  const emit = makeEmit(env, ctx, uid);
  const t0 = Date.now();
  const limited = await rateLimit(env, `hf_introvid:${uid}`, 10, 3600);
  if (limited) return limited;
  const lang = req.headers.get("x-lang");
  const topic = req.headers.get("x-topic");
  if (lang && !isIntroLang(lang)) return err(400, "invalid_field", { field: "lang", message: "Pick a language from the list." });
  if (topic && topic !== "general" && !isCategoryId(topic)) return err(400, "invalid_field", { field: "topic", message: "Pick a category or General." });
  const mime = req.headers.get("content-type") ?? "";
  const bytes = await boundedBytes(req, INTRO_VIDEO_MAX_BYTES).catch(() => null);
  const chk = validateIntroVideo(mime, bytes, req.headers.get("x-duration-ms"), req.headers.get("x-video-width"), req.headers.get("x-video-height"));
  if (!chk.ok) {
    emit("hf_intro_upload", { ok: false, reason: chk.error, bytes: bytes?.byteLength ?? 0, ms: Date.now() - t0 });
    return err(chk.status, chk.error, { message: chk.message });
  }
  // [HF-INTRO-P] phones write moov at the END; move it first so Range prefetch can start playback.
  const body: Uint8Array = chk.mime === "video/mp4" ? faststartMp4(bytes!) : bytes!;
  const id = newIntroVideoId();
  const key = `intro-video/${uid}/${id}.${chk.ext}`;
  const now = Date.now();
  let replaced: IntroFileRow[] = [];
  try {
    replaced = (await env.DB_META.prepare("SELECT id, uid, r2_key, poster_key, bytes FROM hf_intro_videos WHERE uid=?1 AND status='draft'").bind(uid).all<IntroFileRow>()).results ?? [];
    await env.BLOBS.put(key, body, { httpMetadata: { contentType: chk.mime, cacheControl: IMMUTABLE } });
    await env.DB_META.batch([
      env.DB_META.prepare("UPDATE hf_intro_videos SET status='replaced', updated_at=?2 WHERE uid=?1 AND status='draft'").bind(uid, now),
      env.DB_META.prepare("INSERT INTO hf_intro_videos (id,uid,r2_key,poster_key,mime,bytes,duration_ms,width,height,lang,topic,views,status,created_at,updated_at) VALUES (?1,?2,?3,NULL,?4,?5,?6,?7,?8,?9,?10,0,'draft',?11,?11)")
        .bind(id, uid, key, chk.mime, body.byteLength, chk.durationMs, chk.width, chk.height, lang || null, topic || null, now),
    ]);
  } catch (e) {
    await env.BLOBS.delete(key).catch(() => undefined);
    await trackException(env, e, { uid, route: "/api/hf/onboarding/intro-video", method: "POST", handled: true, app_name: APP, extra: { area: "hf_intro_onboarding", step: "store" } });
    emit("hf_intro_upload", { ok: false, reason: "store_failed", bytes: bytes!.byteLength, ms: Date.now() - t0 });
    return err(500, "store_failed", { message: "We could not save your video. Please try again." });
  }
  for (const r of replaced) await deleteIntroVideoFiles(env, r, "draft_replaced"); // [HF-INTRO-DELETE-1] also marks the row + telemetry
  emit("hf_intro_upload", { ok: true, bytes: bytes!.byteLength, ms: Date.now() - t0, duration_ms: chk.durationMs });
  const row = await env.DB_META.prepare("SELECT * FROM hf_intro_videos WHERE id=?1").bind(id).first<VideoRow>();
  return json({ ok: true, video: videoJson(env, row!) }, 200, NO_STORE);
}

// ── PUT poster ────────────────────────────────────────────────────────────────────────────────────────────────
async function uploadPoster(req: Request, env: Env, ctx: ExecutionContext | undefined, id: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const uid = u.uid;
  const v = await env.DB_META.prepare("SELECT * FROM hf_intro_videos WHERE id=?1 AND uid=?2").bind(id, uid).first<VideoRow>();
  if (!v) return err(404, "video_not_found");
  if ((v.status !== "draft" && v.status !== "rejected") || v.deleted_at) return err(409, "video_locked", { message: "This video can not be changed any more." });
  const limited = await rateLimit(env, `hf_introposter:${uid}`, 20, 3600);
  if (limited) return limited;
  const bytes = await boundedBytes(req, INTRO_POSTER_MAX_BYTES).catch(() => null);
  const chk = validateIntroPoster(req.headers.get("content-type") ?? "", bytes);
  if (!chk.ok) return err(chk.status, chk.error, { message: chk.message });
  const key = `intro-video/${uid}/${id}-poster-${Date.now()}.${chk.ext}`;
  try {
    await env.BLOBS.put(key, bytes!, { httpMetadata: { contentType: chk.mime, cacheControl: IMMUTABLE } });
    await env.DB_META.prepare("UPDATE hf_intro_videos SET poster_key=?2, updated_at=?3 WHERE id=?1").bind(id, key, Date.now()).run();
  } catch (e) {
    await env.BLOBS.delete(key).catch(() => undefined);
    await trackException(env, e, { uid, route: "/api/hf/onboarding/intro-video/poster", method: "PUT", handled: true, app_name: APP, extra: { area: "hf_intro_onboarding", step: "poster_store" } });
    return err(500, "store_failed", { message: "We could not save the picture. Please try again." });
  }
  if (v.poster_key) await env.BLOBS.delete(v.poster_key).catch((e) => trackException(env, e, { uid, route: "/api/hf/onboarding/intro-video/poster", handled: true, app_name: APP, extra: { area: "hf_intro_onboarding", step: "delete_old_poster" } }));
  makeEmit(env, ctx, uid)("hf_intro_poster", { ok: true, bytes: bytes!.byteLength });
  return json({ ok: true, video: videoJson(env, { ...v, poster_key: key }) }, 200, NO_STORE);
}

// ── POST submit ───────────────────────────────────────────────────────────────────────────────────────────────
async function submit(req: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const uid = u.uid;
  const emit = makeEmit(env, ctx, uid);
  const b = await readJson(req);
  const cats = normalizeCategories(b.categories);
  if (!cats) return err(400, "invalid_field", { field: "categories", message: "Pick at least one category from the list." });
  if (!isIntroLang(b.lang)) return err(400, "invalid_field", { field: "lang", message: "Pick a language from the list." });
  if (!isCallOption(b.call_option)) return err(400, "invalid_field", { field: "call_option", message: "Choose Bookings only or Bookings + live." });
  const videoId = typeof b.intro_video_id === "string" ? b.intro_video_id : "";
  if (!INTRO_VIDEO_ID_RE.test(videoId)) return err(400, "invalid_field", { field: "intro_video_id", message: "Record your intro video first." });
  const topic = b.topic === undefined || b.topic === null ? null : b.topic === "general" || isCategoryId(b.topic) ? (b.topic as string) : undefined;
  if (topic === undefined) return err(400, "invalid_field", { field: "topic", message: "Pick a category or General." });
  const limited = await rateLimit(env, `hf_introsubmit:${uid}`, 10, 3600);
  if (limited) return limited;

  const [host, video, open, facts] = await Promise.all([
    getHost(env, uid),
    env.DB_META.prepare("SELECT * FROM hf_intro_videos WHERE id=?1 AND uid=?2").bind(videoId, uid).first<VideoRow>(),
    env.DB_META.prepare("SELECT id FROM hf_influencer_applications WHERE uid=?1 AND status='submitted' LIMIT 1").bind(uid).first<{ id: string }>(),
    onboardingFacts(env, uid),
  ]);
  if (!video) return err(404, "video_not_found", { message: "We could not find your video. Please record it again." });
  if ((video.status !== "draft" && video.status !== "rejected") || video.deleted_at) return err(409, "video_not_available", { message: "This video was already used. Please record a new one." });
  if (open) return err(409, "already_submitted", { message: "You already sent your profile. A person from our team will check it." });

  const hasPhoto = host ? !!(host.avatar_id || (await env.DB_META.prepare("SELECT 1 AS x FROM hf_host_media WHERE uid=?1 AND kind='profile' AND status='active' LIMIT 1").bind(uid).first())) : false;
  const missing: string[] = [];
  if (!host?.display_name) missing.push("name");
  if (!host?.about || !host.about.trim()) missing.push("description");
  if (!hasPhoto) missing.push("photo");
  if (!validCreatorRate(host?.price_per_min)) missing.push("rate");
  if (!facts.whatsappVerified) missing.push("whatsapp");
  if (missing.length) {
    emit("hf_onb_submit_refused", { reason: "incomplete", missing: missing.join(",") });
    return err(422, "incomplete", { missing, message: "A few steps are still missing." });
  }
  const gate = submissionGate({ categories: cats, hasVerifiedSocial: facts.socials.length > 0, aadhaarDone: facts.aadhaarDone, aadhaarGender: facts.aadhaarGender });
  if (gate) {
    emit("hf_onb_submit_refused", { reason: gate });
    return err(gate === "aadhaar_required" ? 409 : 403, gate, { message: GATE_MESSAGES[gate] });
  }

  const now = Date.now();
  const appId = newApplicationId();
  try {
    await env.DB_META.batch([
      env.DB_META.prepare("INSERT INTO hf_influencer_applications (id,uid,status,categories_json,lang,intro_video_id,call_option,rate_rupees,has_socials,aadhaar_ok,submitted_at) VALUES (?1,?2,'submitted',?3,?4,?5,?6,?7,?8,?9,?10)")
        .bind(appId, uid, JSON.stringify(cats), b.lang, videoId, b.call_option, host!.price_per_min, facts.socials.length > 0 ? 1 : 0, facts.aadhaarDone ? 1 : 0, now),
      env.DB_META.prepare("UPDATE hf_intro_videos SET status='submitted', lang=?2, topic=COALESCE(?3, topic), updated_at=?4 WHERE id=?1").bind(videoId, b.lang, topic, now),
    ]);
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String((e as Error)?.message ?? e))) return err(409, "already_submitted", { message: "You already sent your profile. A person from our team will check it." });
    throw e;
  }
  emit("hf_onb_categories", { n: cats.length, has_sensitive: cats.some(isSensitiveCategory) });
  emit("hf_onb_submitted", { n_categories: cats.length, has_sensitive: cats.some(isSensitiveCategory), call_option: b.call_option, lang: b.lang, has_socials: facts.socials.length > 0, aadhaar: facts.aadhaarDone, application_id: appId });
  const row = await env.DB_META.prepare("SELECT * FROM hf_influencer_applications WHERE id=?1").bind(appId).first<AppRow>();
  return json({ ok: true, application: applicationJson(row!), message: SUBMITTED_MESSAGE }, 200, NO_STORE);
}

/** Returns null when the path is not ours so index.ts can fall through. */
export async function hfIntroOnboardingRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  if (!p.startsWith("/api/hf/onboarding/")) return null;
  const m = req.method;
  const poster = p.match(/^\/api\/hf\/onboarding\/intro-video\/(hfin_[a-f0-9]{20})\/poster$/);
  const ours = (p === "/api/hf/onboarding/categories" && m === "GET") || (p === "/api/hf/onboarding/me" && m === "GET") || (p === "/api/hf/onboarding/intro-video" && m === "POST")
    || (p === "/api/hf/onboarding/submit" && m === "POST") || (!!poster && m === "PUT");
  if (!ours) return null;
  try {
    if (!(await enabled(env))) return err(404, "not_enabled");
    if (p === "/api/hf/onboarding/categories") return categories();
    if (p === "/api/hf/onboarding/me") return await me(req, env);
    if (p === "/api/hf/onboarding/intro-video") return await uploadVideo(req, env, ctx);
    if (p === "/api/hf/onboarding/submit") return await submit(req, env, ctx);
    return await uploadPoster(req, env, ctx, poster![1]);
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: APP, extra: { area: "hf_intro_onboarding" } });
    return err(500, "internal_error", { message: "Something went wrong. Please try again." });
  }
}
