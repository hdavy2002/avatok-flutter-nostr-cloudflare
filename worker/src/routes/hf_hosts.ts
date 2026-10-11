// [HF-HOST-PLATFORM-1 2026-10-09] HF host onboarding APIs (profile, avatars, voice sample, submit). Contract: Specs/HF-HOST-PLATFORM-CONTRACT.md
//   GET/PUT /api/hosts/me · GET /api/hosts/avatars · POST /api/hosts/avatars/:id/claim
//   PUT /api/hosts/me/voice (POST /api/hosts/voice kept as an alias) · GET /api/hosts/me/voice   [HF-VOICE-INTRO-1: host's own recorded introduction]
//   PUT /api/hosts/me/generated · POST /api/hosts/submit          (flag hostOnboardingEnabled; 404 not_enabled when off)
// /api/hosts/generate* belongs to the workflow agent; /api/hosts/public* to hf_hosts_public.ts.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackUser, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { emailFor } from "../lib/identity";
import { readConfig } from "./config";
import { getHost, upsertHost, listMedia, hostToJson, mediaToJson, mediaUrl, avatarUrlFor, type HostPatch } from "../lib/hf_host_store";
import { normalizeIntroMime, validateIntro, INTRO_ACCEPTED_TYPES, INTRO_MAX_BYTES } from "../lib/hf_intro";
import { transcribeAndFlag } from "../lib/hf_intro_check";
import { TOPIC_SLUGS, LANGUAGES, LANGUAGE_CODE_SET, STYLES, PRICE_MIN, PRICE_MAX, contactLeak } from "../lib/hf_options";

const APP = BRAND.slug;
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

function makeEmit(env: Env, ctx: ExecutionContext | undefined, uid: string) {
  return (event: string, props: Record<string, unknown> = {}): void => {
    const p = (async () => {
      const email = await emailFor(env, uid).catch(() => null);
      await trackUser(env, uid, email, event, APP, { area: "hf_host", ...props });
    })().catch(() => { /* best-effort */ });
    if (ctx) ctx.waitUntil(p);
  };
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 20_000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

// ── KYC summary (same shape as GET /api/hosts/kyc/status) ───────────────────
async function kycSummary(env: Env, uid: string) {
  const [kyc, selfie, payout] = await Promise.all([
    env.DB_META.prepare("SELECT role, aadhaar_last4, gender, verified_at FROM hf_kyc WHERE uid=?1").bind(uid).first<{ role: string; aadhaar_last4: string | null; gender: string | null; verified_at: number | null }>().catch(() => null),
    env.DB_META.prepare("SELECT review_status, review_reason FROM hf_selfie WHERE uid=?1 ORDER BY created_at DESC, id DESC LIMIT 1").bind(uid).first<{ review_status: string; review_reason: string | null }>().catch(() => null),
    env.DB_META.prepare("SELECT name_match, account_last4, upi_verified FROM hf_payout WHERE uid=?1").bind(uid).first<{ name_match: number; account_last4: string | null; upi_verified: number }>().catch(() => null),
  ]);
  return {
    aadhaar: { done: !!kyc?.verified_at, gender: kyc?.gender ?? null, last4: kyc?.aadhaar_last4 ?? null, role: kyc?.role ?? null },
    selfie: { status: selfie?.review_status ?? "none", reason: selfie?.review_status === "rejected" ? selfie.review_reason : null },
    payout: { done: !!payout && payout.name_match === 1, match: payout ? payout.name_match === 1 : false, accountLast4: payout?.account_last4 ?? null, upiVerified: payout ? payout.upi_verified === 1 : false },
  };
}

async function latestJob(env: Env, uid: string) {
  const j = await env.DB_META.prepare("SELECT id, kind, status, stage, stages_json, error, created_at, updated_at FROM hf_media_jobs WHERE uid=?1 AND kind='host_media' ORDER BY created_at DESC LIMIT 1")
    .bind(uid).first<{ id: string; kind: string; status: string; stage: string | null; stages_json: string; error: string | null; created_at: number; updated_at: number }>().catch(() => null);
  if (!j) return null;
  let stages: unknown = {}; try { stages = JSON.parse(j.stages_json || "{}"); } catch { /* */ }
  return { id: j.id, status: j.status, stage: j.stage, stages, error: j.error, createdAt: j.created_at, updatedAt: j.updated_at };
}

async function hostJson(env: Env, uid: string) {
  const r = await getHost(env, uid);
  return r ? hostToJson(env, r, await avatarUrlFor(env, r.avatar_id)) : null;
}

// ── GET /api/hosts/me ────────────────────────────────────────────────────────
async function getMe(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const [host, kyc, media, job] = await Promise.all([hostJson(env, u.uid), kycSummary(env, u.uid), listMedia(env, u.uid).catch(() => []), latestJob(env, u.uid)]);
  return json({ host, kyc, media: media.map((m) => mediaToJson(env, m)), job }, 200, { "cache-control": "private, no-store" });
}

// ── PUT /api/hosts/me ────────────────────────────────────────────────────────
const bad = (field: string, message: string, status = 400) => err(status, "invalid_field", { field, message });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

async function putMe(req: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const uid = u.uid;
  const b = await readJson(req);
  const cur = await getHost(env, uid);
  const status = cur?.status ?? "draft";
  const priceHoursOnly = status === "live";
  if (status === "generating" || status === "pending_review") return err(409, "locked", { message: "Your profile is being prepared or reviewed — you can edit it once that finishes." });

  const patch: HostPatch = {};
  const changed: string[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const locked = (k: string) => priceHoursOnly && has(k);

  if (has("displayName")) {
    if (locked("displayName")) return err(409, "locked", { field: "displayName" });
    const v = typeof b.displayName === "string" ? b.displayName.trim() : "";
    if (v.length < 2 || v.length > 40) return bad("displayName", "Use a name between 2 and 40 characters.");
    if (contactLeak(v)) return bad("displayName", "Please don’t put phone numbers, links or app names in your name.", 422);
    patch.display_name = v; changed.push("displayName");
  }
  if (has("about")) {
    if (locked("about")) return err(409, "locked", { field: "about" });
    const v = typeof b.about === "string" ? b.about.trim() : "";
    if (v.length > 600) return bad("about", "Keep it under 600 characters.");
    if (contactLeak(v)) return bad("about", "Please don’t put phone numbers, links, @handles or app names in your bio.", 422);
    patch.about = v; changed.push("about");
  }
  if (has("languages")) {
    if (locked("languages")) return err(409, "locked", { field: "languages" });
    const a = b.languages;
    if (!Array.isArray(a) || a.length < 1 || a.length > 6 || !a.every((x) => typeof x === "string" && (LANGUAGES as readonly string[]).includes(x))) return bad("languages", "Pick 1 to 6 languages from the list.");
    patch.languages_json = JSON.stringify([...new Set(a as string[])]); changed.push("languages");
  }
  if (has("style")) {
    if (locked("style")) return err(409, "locked", { field: "style" });
    if (typeof b.style !== "string" || !(STYLES as readonly string[]).includes(b.style)) return bad("style", "Pick a style from the list.");
    patch.style = b.style; changed.push("style");
  }
  if (has("topics")) {
    if (locked("topics")) return err(409, "locked", { field: "topics" });
    const a = b.topics;
    if (!Array.isArray(a) || a.length < 1 || a.length > 6 || !a.every((x) => typeof x === "string" && TOPIC_SLUGS.has(x))) return bad("topics", "Pick 1 to 6 topics.");
    patch.topics_json = JSON.stringify([...new Set(a as string[])]); changed.push("topics");
  }
  if (has("conversationLang")) {
    if (locked("conversationLang")) return err(409, "locked", { field: "conversationLang" });
    if (typeof b.conversationLang !== "string" || !LANGUAGE_CODE_SET.has(b.conversationLang)) return bad("conversationLang", "Pick a conversation language from the list.");
    patch.conversation_lang = b.conversationLang; changed.push("conversationLang");
  }
  if (has("pricePerMin")) {
    const n = b.pricePerMin;
    if (typeof n !== "number" || !Number.isInteger(n) || n < PRICE_MIN || n > PRICE_MAX) return bad("pricePerMin", `Price must be a whole number from ₹${PRICE_MIN} to ₹${PRICE_MAX} per minute.`);
    patch.price_per_min = n; changed.push("pricePerMin");
  }
  if (has("hours")) {
    const h = b.hours as { days?: unknown; from?: unknown; to?: unknown } | null;
    const okDays = h && Array.isArray(h.days) && h.days.length >= 1 && h.days.length <= 7 && h.days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6);
    if (!h || typeof h !== "object" || !okDays || typeof h.from !== "string" || typeof h.to !== "string" || !HHMM.test(h.from) || !HHMM.test(h.to)) return bad("hours", "Pick days (0–6) and a from/to time like 18:00.");
    patch.hours_json = JSON.stringify({ days: [...new Set(h.days as number[])].sort(), from: h.from, to: h.to }); changed.push("hours");
  }
  if (has("healthConsent")) {
    if (locked("healthConsent")) return err(409, "locked", { field: "healthConsent" });
    if (typeof b.healthConsent !== "boolean") return bad("healthConsent", "healthConsent must be true or false.");
    patch.health_consent = b.healthConsent ? 1 : 0; changed.push("healthConsent");
  }
  let lgbtqLane = cur?.lgbtq_lane === 1;
  if (has("womenLane")) {
    if (locked("womenLane")) return err(409, "locked", { field: "womenLane" });
    if (typeof b.womenLane !== "boolean") return bad("womenLane", "womenLane must be true or false.");
    if (b.womenLane) {
      const k = await env.DB_META.prepare("SELECT gender FROM hf_kyc WHERE uid=?1 AND verified_at IS NOT NULL").bind(uid).first<{ gender: string | null }>().catch(() => null);
      if (k?.gender !== "F") return err(403, "women_lane_not_allowed", { field: "womenLane", message: "The women-only lane is open to hosts whose verified ID shows female." });
    }
    patch.women_lane = b.womenLane ? 1 : 0; changed.push("womenLane");
  }
  if (has("lgbtqLane")) {
    if (locked("lgbtqLane")) return err(409, "locked", { field: "lgbtqLane" });
    if (typeof b.lgbtqLane !== "boolean") return bad("lgbtqLane", "lgbtqLane must be true or false.");
    lgbtqLane = b.lgbtqLane;
    patch.lgbtq_lane = lgbtqLane ? 1 : 0; changed.push("lgbtqLane");
    if (!lgbtqLane) patch.lgbtq_public = 0;
  }
  if (has("lgbtqPublic")) {
    if (locked("lgbtqPublic")) return err(409, "locked", { field: "lgbtqPublic" });
    if (typeof b.lgbtqPublic !== "boolean") return bad("lgbtqPublic", "lgbtqPublic must be true or false.");
    if (b.lgbtqPublic && !lgbtqLane) return bad("lgbtqPublic", "Turn on the LGBTQ lane first.", 422);
    patch.lgbtq_public = b.lgbtqPublic ? 1 : 0; changed.push("lgbtqPublic");
  }
  if (has("agreements")) {
    if (b.agreements !== true) return bad("agreements", "You need to accept the host agreements to continue.");
    patch.agreements_at = Date.now(); changed.push("agreements");
  }

  try {
    await upsertHost(env, uid, patch);
  } catch (e) {
    await trackException(env, e, { uid, route: "/api/hosts/me", method: "PUT", handled: true, app_name: APP, extra: { area: "hf_host" } });
    return err(500, "save_failed", { message: "We couldn’t save that. Please try again." });
  }
  makeEmit(env, ctx, uid)("hf_host_profile_saved", { fields: changed.join(","), status });
  return json({ host: await hostJson(env, uid) });
}

// ── avatars ──────────────────────────────────────────────────────────────────
async function listAvatars(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const q = new URL(req.url).searchParams;
  const where = ["status='active'"]; const binds: unknown[] = [];
  const g = q.get("gender"); if (g === "woman" || g === "man") { binds.push(g); where.push(`gender=?${binds.length}`); }
  const a = q.get("age"); if (a && ["20s", "30s", "40s", "50s+"].includes(a)) { binds.push(a); where.push(`age_band=?${binds.length}`); }
  const l = q.get("look"); if (l && ["traditional", "casual", "office"].includes(l)) { binds.push(l); where.push(`look=?${binds.length}`); }
  const rows = (await env.DB_META.prepare(`SELECT id, image_key, gender, age_band, look, taken_by_uid FROM hf_avatars WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 120`)
    .bind(...binds).all<{ id: string; image_key: string; gender: string; age_band: string; look: string; taken_by_uid: string | null }>()).results ?? [];
  return json(rows.map((r) => ({ id: r.id, url: mediaUrl(env, r.image_key), gender: r.gender, age: r.age_band, look: r.look, taken: !!r.taken_by_uid && r.taken_by_uid !== u.uid, mine: r.taken_by_uid === u.uid })), 200, { "cache-control": "private, no-store" });
}

async function claimAvatar(req: Request, env: Env, ctx: ExecutionContext | undefined, id: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const uid = u.uid;
  const cur = await getHost(env, uid);
  if (cur && ["generating", "pending_review", "live"].includes(cur.status)) return err(409, "locked", { message: "You can’t change your avatar right now." });
  const av = await env.DB_META.prepare("SELECT id, taken_by_uid FROM hf_avatars WHERE id=?1 AND status='active'").bind(id).first<{ id: string; taken_by_uid: string | null }>();
  if (!av) return err(404, "avatar_not_found");
  if (av.taken_by_uid && av.taken_by_uid !== uid) return err(409, "avatar_taken", { message: "Someone just picked that one. Please choose another." });
  const prev = await env.DB_META.prepare("SELECT id FROM hf_avatars WHERE taken_by_uid=?1").bind(uid).first<{ id: string }>();
  const now = Date.now();
  try {
    const res = await env.DB_META.batch([
      env.DB_META.prepare("UPDATE hf_avatars SET taken_by_uid=NULL WHERE taken_by_uid=?1 AND id<>?2").bind(uid, id),
      env.DB_META.prepare("UPDATE hf_avatars SET taken_by_uid=?1 WHERE id=?2 AND status='active' AND (taken_by_uid IS NULL OR taken_by_uid=?1)").bind(uid, id),
      env.DB_META.prepare("INSERT OR IGNORE INTO hf_hosts (uid, created_at, updated_at) VALUES (?1,?2,?2)").bind(uid, now),
      env.DB_META.prepare("UPDATE hf_hosts SET avatar_id=?2, updated_at=?3 WHERE uid=?1 AND EXISTS (SELECT 1 FROM hf_avatars WHERE id=?2 AND taken_by_uid=?1)").bind(uid, id, now),
    ]);
    if (!res[1]?.meta?.changes && av.taken_by_uid !== uid) {
      // Lost a race: put the previous avatar back.
      if (prev && prev.id !== id) {
        await env.DB_META.prepare("UPDATE hf_avatars SET taken_by_uid=?1 WHERE id=?2 AND taken_by_uid IS NULL").bind(uid, prev.id).run().catch(() => {});
      }
      return err(409, "avatar_taken", { message: "Someone just picked that one. Please choose another." });
    }
  } catch (e) {
    await trackException(env, e, { uid, route: "/api/hosts/avatars/claim", method: "POST", handled: true, app_name: APP, extra: { area: "hf_host" } });
    return err(500, "claim_failed");
  }
  makeEmit(env, ctx, uid)("hf_host_avatar_claimed", { switched: !!prev && prev.id !== id });
  return json({ ok: true, avatarId: id });
}

// ── PUT /api/hosts/me/voice  (alias: POST /api/hosts/voice) ──────────────────
// [HF-VOICE-INTRO-1] The host's OWN voice introduction (30 s - 5 min). Private copy in VERIFICATION until an admin approves it.
// A live/paused host may re-record: the profile stays online and the old approved intro keeps playing until the new one is approved.
async function uploadVoice(req: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const uid = u.uid;
  const consent = (req.headers.get("x-voice-consent") || "").trim();
  if (consent !== "1" && consent !== "v1") return err(400, "consent_required", { message: "Please agree to the voice-use notice to continue.", field: "consent" });
  const nm = normalizeIntroMime(req.headers.get("content-type"));
  if (!nm) return err(415, "unsupported_type", { message: "Unsupported audio format.", accepted: INTRO_ACCEPTED_TYPES });
  const secsRaw = req.headers.get("x-duration-seconds") ?? req.headers.get("x-voice-seconds");
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > INTRO_MAX_BYTES) return err(413, "too_large", { message: "That recording is too large. Please record a shorter one.", max_bytes: INTRO_MAX_BYTES });
  const cur = await getHost(env, uid);
  if (cur && ["generating", "pending_review"].includes(cur.status)) return err(409, "locked", { message: "Your profile is being prepared or reviewed — you can record again once that finishes." });
  const lim = await rateLimit(env, `hf_intro:${uid}`, 6, 3600);
  if (lim) return lim;

  const buf = await req.arrayBuffer().catch(() => null);
  if (!buf) return err(400, "bad_body");
  const chk = validateIntro(secsRaw, buf.byteLength);
  if (!chk.ok) return err(chk.status, chk.error, { message: chk.message });

  const now = Date.now();
  const key = `hf/intro/${uid}/${now}.${nm.ext}`;
  try {
    await env.VERIFICATION.put(key, buf, { httpMetadata: { contentType: nm.mime } });
    await upsertHost(env, uid, {
      voice_sample_r2: key, voice_seconds: chk.seconds, voice_consent_at: now,
      intro_mime: nm.mime, intro_status: "pending", intro_transcript: null, intro_flags_json: null, intro_uploaded_at: now,
    });
    // The approved public copy lives in BLOBS, so the superseded private source can go.
    if (cur?.voice_sample_r2 && cur.voice_sample_r2 !== key) await env.VERIFICATION.delete(cur.voice_sample_r2).catch(() => {});
  } catch (e) {
    await env.VERIFICATION.delete(key).catch(() => {});
    await trackException(env, e, { uid, route: "/api/hosts/me/voice", method: "PUT", handled: true, app_name: APP, extra: { area: "hf_host" } });
    return err(500, "store_failed", { message: "We couldn’t save your recording. Please try again." });
  }
  makeEmit(env, ctx, uid)("hf_host_intro_uploaded", { seconds: chk.seconds, mime: nm.mime });
  // Durable Workflow first (a 5-minute clip can outlive ctx.waitUntil); fall back to waitUntil if the binding is missing or create fails.
  let queued = false;
  if (env.INTRO_CHECK) {
    try { await env.INTRO_CHECK.create({ id: `intro-${uid}-${now}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100), params: { uid, key, mime: nm.mime, uploadedAt: now } }); queued = true; }
    catch (e) { await trackException(env, e, { uid, route: "/api/hosts/me/voice", method: "PUT", handled: true, app_name: APP, extra: { area: "hf_host", step: "intro_check_create" } }); }
  }
  if (!queued) {
    const job = transcribeAndFlag(env, uid, key, nm.mime, now).catch(() => {});
    if (ctx) ctx.waitUntil(job);
  }
  return json({ ok: true, voice: { seconds: chk.seconds, mime: nm.mime, status: "pending", uploadedAt: now } });
}

// ── GET /api/hosts/me/voice — the host's own latest intro (private) ──────────
async function getVoice(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const cur = await getHost(env, u.uid);
  if (!cur?.voice_sample_r2 || !cur.intro_status) return err(404, "no_intro");
  const range = req.headers.get("range");
  const obj = await env.VERIFICATION.get(cur.voice_sample_r2, range ? { range: req.headers } : undefined);
  if (!obj) return err(404, "no_intro");
  const headers = new Headers({
    "content-type": cur.intro_mime || obj.httpMetadata?.contentType || "audio/mp4", "cache-control": "private, no-store",
    "x-content-type-options": "nosniff", "accept-ranges": "bytes",
  });
  const rg = (obj as unknown as { range?: { offset?: number; length?: number } }).range;
  if (range && rg && rg.offset != null && rg.length != null) {
    headers.set("content-range", `bytes ${rg.offset}-${rg.offset + rg.length - 1}/${obj.size}`);
    headers.set("content-length", String(rg.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

// ── PUT /api/hosts/me/generated ──────────────────────────────────────────────
async function putGenerated(req: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const cur = await getHost(env, u.uid);
  if (!cur) return err(404, "no_host");
  if (!["pending_host", "rejected", "paused"].includes(cur.status)) return err(409, "locked", { message: "You can edit these once your profile is ready for your review." });
  const b = await readJson(req);
  const patch: HostPatch = {}; const changed: string[] = [];
  const lim: Record<string, [number, "tagline" | "quote" | "about_polished"]> = { tagline: [120, "tagline"], quote: [240, "quote"], aboutPolished: [900, "about_polished"] };
  for (const [k, [max, col]] of Object.entries(lim)) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
    const v = typeof b[k] === "string" ? (b[k] as string).trim() : "";
    if (!v || v.length > max) return bad(k, `Use 1 to ${max} characters.`);
    if (contactLeak(v)) return bad(k, "Please don’t put phone numbers, links, @handles or app names here.", 422);
    patch[col] = v; changed.push(k);
  }
  await upsertHost(env, u.uid, patch);
  makeEmit(env, ctx, u.uid)("hf_host_profile_saved", { fields: changed.join(","), generated: true });
  return json({ host: await hostJson(env, u.uid) });
}

// ── POST /api/hosts/submit ───────────────────────────────────────────────────
async function submit(req: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const uid = u.uid;
  const cur = await getHost(env, uid);
  if (!cur) return err(404, "no_host");
  if (!["pending_host", "rejected", "paused"].includes(cur.status)) return err(409, "bad_status", { status: cur.status, message: cur.status === "pending_review" ? "Already submitted for review." : "Your profile isn’t ready to submit yet." });
  const [kyc, media] = await Promise.all([kycSummary(env, uid), listMedia(env, uid)]);
  const missing: string[] = [];
  if (!kyc.aadhaar.done) missing.push("aadhaar");
  if (kyc.selfie.status === "none" || kyc.selfie.status === "rejected") missing.push("selfie");
  if (!kyc.payout.done) missing.push("payout");
  if (!cur.agreements_at) missing.push("agreements");
  if (!cur.display_name || !cur.avatar_id) missing.push("profile");
  if (!media.some((m) => m.kind === "profile") || !media.some((m) => m.kind === "gallery")) missing.push("media");
  if (!cur.voice_sample_r2 || (cur.intro_status !== "pending" && cur.intro_status !== "approved")) missing.push("voice");
  if (missing.length) return err(422, "incomplete", { missing, message: "A few steps are still missing." });
  const now = Date.now();
  const r = await env.DB_META.prepare("UPDATE hf_hosts SET status='pending_review', submitted_at=?2, updated_at=?2 WHERE uid=?1 AND status IN ('pending_host','rejected','paused')").bind(uid, now).run();
  if (!r.meta?.changes) return err(409, "bad_status");
  makeEmit(env, ctx, uid)("hf_host_submitted", { media: media.length });
  return json({ ok: true });
}

// ── router ───────────────────────────────────────────────────────────────────
/** Returns null when the path is not ours (index.ts falls through). */
export async function hfHostsRoute(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const p = new URL(req.url).pathname;
  const m = req.method;
  const claim = p.match(/^\/api\/hosts\/avatars\/([A-Za-z0-9._:-]{1,64})\/claim$/);
  const ours = p === "/api/hosts/me" || p === "/api/hosts/me/generated" || p === "/api/hosts/avatars" || !!claim || p === "/api/hosts/voice" || p === "/api/hosts/me/voice" || p === "/api/hosts/submit";
  if (!ours) return null;
  try {
    if ((await readConfig(env)).hostOnboardingEnabled !== true) return err(404, "not_enabled");
    if (p === "/api/hosts/me" && m === "GET") return await getMe(req, env);
    if (p === "/api/hosts/me" && m === "PUT") return await putMe(req, env, ctx);
    if (p === "/api/hosts/me/generated" && m === "PUT") return await putGenerated(req, env, ctx);
    if (p === "/api/hosts/avatars" && m === "GET") return await listAvatars(req, env);
    if (claim && m === "POST") return await claimAvatar(req, env, ctx, claim[1]);
    if ((p === "/api/hosts/me/voice" && m === "PUT") || (p === "/api/hosts/voice" && m === "POST")) return await uploadVoice(req, env, ctx);
    if (p === "/api/hosts/me/voice" && m === "GET") return await getVoice(req, env);
    if (p === "/api/hosts/submit" && m === "POST") return await submit(req, env, ctx);
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: APP, extra: { area: "hf_host" } });
    return err(500, "internal_error");
  }
}
