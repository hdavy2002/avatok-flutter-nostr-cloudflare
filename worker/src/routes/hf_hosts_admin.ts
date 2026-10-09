// [HF-HOST-PLATFORM-1] HF host review + avatar library admin API (ADMIN_UIDS only).
//   GET  /api/admin/hf/hosts?status=            list
//   GET  /api/admin/hf/hosts/:uid               host + media + KYC summary (selfie/Aadhaar photo via /api/admin/hf/kyc signed URLs)
//   POST /api/admin/hf/hosts/:uid/decision      { decision: approve|reject|pause, reason }   (approve also approves a pending voice intro)
//   POST /api/admin/hf/hosts/:uid/intro         { decision: approve|reject, reason? }        [HF-VOICE-INTRO-1] review a (re-)recorded voice intro on its own
//   GET  /api/admin/hf/hosts/intro-media?t=     streams the host's private intro (signed, 5 min, audited)
//   GET  /api/admin/hf/avatars                  avatar library
//   POST /api/admin/hf/avatars/generate         { count<=12, gender, age, look }  -> queues an avatar_batch job
//   POST /api/admin/hf/avatars/fill             { target?: 1..8 (default 4) } -> ONE sequential avatar_batch job topping every gender x age x look up to target
//   POST /api/admin/hf/avatars/:id/retire
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { track, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { buildAvatarFillPlan, planTotal, MAX_PLAN_TOTAL, type AvatarPlanEntry } from "../lib/hf_avatar_plan";
import { isAdminUid } from "../lib/preview";
import { tryDecryptPii } from "../lib/pii_crypto";
import { sendWhatsAppText } from "../lib/whatsapp_send";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { piiKeyBytes, piiKeyConfigured } from "../lib/pii_crypto";
import { parseStoredFlags, introStatusOf, introCaption, INTRO_MEDIA_KIND } from "../lib/hf_intro";


const APP = BRAND.slug;
const STATUSES = ["draft", "generating", "pending_host", "pending_review", "live", "paused", "rejected"];
const GENDERS = ["woman", "man"];
const AGES = ["20s", "30s", "40s", "50s+"];
const LOOKS = ["traditional", "casual", "office"];
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const arr = (s: unknown): unknown[] => { try { const v = JSON.parse(String(s ?? "[]")); return Array.isArray(v) ? v : []; } catch { return []; } };
const obj = (s: unknown): Record<string, unknown> => { try { const v = JSON.parse(String(s ?? "{}")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const mediaBase = (env: Env) => String(env.BLOSSOM_BASE_URL || "").replace(/\/+$/, "");

async function audit(env: Env, adminUid: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), adminUid, `hf_host_${action}`, target, JSON.stringify(meta), Date.now()).run();
  } catch (e) {
    await trackException(env, e, { route: "/api/admin/hf/hosts", handled: true, app_name: APP, extra: { area: "hf_hosts_admin", step: "admin_audit", action } });
  }
}

async function adminCtx(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  if (!isAdminUid(env, u.uid)) return err(403, "forbidden");
  return { uid: u.uid };
}
async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 16_000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

type HostRow = {
  uid: string; slug: string | null; status: string; display_name: string | null; about: string | null; tagline: string | null; quote: string | null;
  about_polished: string | null; languages_json: string; style: string | null; topics_json: string; conversation_lang: string | null;
  price_per_min: number; hours_json: string; health_consent: number; women_lane: number; lgbtq_lane: number; lgbtq_public: number;
  avatar_id: string | null; voice_seconds: number | null; voice_sample_r2: string | null; intro_mime: string | null; intro_status: string | null;
  intro_transcript: string | null; intro_flags_json: string | null; intro_uploaded_at: number | null; gen_attempts: number; review_note: string | null; live_at: number | null;
  submitted_at: number | null; updated_at: number; avatar_key?: string | null;
};
const HOST_SQL = `SELECT h.*, a.image_key AS avatar_key FROM hf_hosts h LEFT JOIN hf_avatars a ON a.id = h.avatar_id`;

function hostJson(env: Env, h: HostRow) {
  return {
    uid: h.uid, slug: h.slug, status: h.status, displayName: h.display_name, about: h.about, tagline: h.tagline, quote: h.quote,
    aboutPolished: h.about_polished, languages: arr(h.languages_json), style: h.style, topics: arr(h.topics_json), conversationLang: h.conversation_lang,
    pricePerMin: h.price_per_min, hours: obj(h.hours_json), healthConsent: !!h.health_consent, womenLane: !!h.women_lane, lgbtqLane: !!h.lgbtq_lane,
    lgbtqPublic: !!h.lgbtq_public, avatarId: h.avatar_id, avatarUrl: h.avatar_key ? `${mediaBase(env)}/${h.avatar_key}` : null,
    voice: { seconds: h.intro_status ? h.voice_seconds : null, mime: h.intro_status ? h.intro_mime : null, status: introStatusOf(h.intro_status), uploadedAt: h.intro_status ? h.intro_uploaded_at : null },
    genAttempts: h.gen_attempts, reviewNote: h.review_note, liveAt: h.live_at,
    submittedAt: h.submitted_at, updatedAt: h.updated_at,
  };
}

// ── voice intro: signed streaming + approval ─────────────────────────────────
// [HF-VOICE-INTRO-1] Same signed-token pattern as hf_host_kyc media (HMAC over HF_PII_KEY, 5 min, admin-bound, audited), own domain string.
const INTRO_URL_TTL_MS = 5 * 60_000;
const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const a = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ""; for (const x of a) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64u = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o;
};
async function introHmacKey(env: Env): Promise<CryptoKey> {
  const raw = piiKeyBytes(env);
  const seed = new Uint8Array(11 + raw.length);
  seed.set(new TextEncoder().encode("hf-intro-v1")); seed.set(raw, 11);
  const k = await crypto.subtle.digest("SHA-256", seed);
  return crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signIntro(env: Env, adminUid: string, uid: string, key: string, mime: string): Promise<string | null> {
  if (!piiKeyConfigured(env)) return null;
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ e: Date.now() + INTRO_URL_TTL_MS, a: adminUid, u: uid, r: key, m: mime })));
  const sig = await crypto.subtle.sign("HMAC", await introHmacKey(env), new TextEncoder().encode(payload));
  return `/api/admin/hf/hosts/intro-media?t=${payload}.${b64u(sig)}`;
}

async function introMedia(req: Request, env: Env): Promise<Response> {
  const t = new URL(req.url).searchParams.get("t") || "";
  const [payload, sig] = t.split(".");
  if (!payload || !sig || !piiKeyConfigured(env)) return err(403, "bad_token");
  let c: { e: number; a: string; u: string; r: string; m: string };
  try {
    const ok = await crypto.subtle.verify("HMAC", await introHmacKey(env), fromB64u(sig), new TextEncoder().encode(payload));
    if (!ok) return err(403, "bad_token");
    c = JSON.parse(new TextDecoder().decode(fromB64u(payload)));
  } catch { return err(403, "bad_token"); }
  if (!(c.e > Date.now())) return err(403, "token_expired");
  if (!isAdminUid(env, c.a)) return err(403, "forbidden");
  if (typeof c.r !== "string" || !c.r.startsWith(`hf/intro/${c.u}/`)) return err(403, "bad_token");
  const range = req.headers.get("range");
  const obj = await env.VERIFICATION.get(c.r, range ? { range: req.headers } : undefined);
  if (!obj) return err(404, "not_found");
  await audit(env, c.a, "view_intro", c.u, { key: c.r });
  const headers = new Headers({ "content-type": c.m || "audio/mp4", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "accept-ranges": "bytes" });
  const rg = (obj as unknown as { range?: { offset?: number; length?: number } }).range;
  if (range && rg && rg.offset != null && rg.length != null) {
    headers.set("content-range", `bytes ${rg.offset}-${rg.offset + rg.length - 1}/${obj.size}`);
    headers.set("content-length", String(rg.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

/** Copies a PENDING private intro to the public BLOBS bucket and makes it the host's active intro_audio. */
async function approvePendingIntro(env: Env, uid: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const h = await env.DB_META.prepare("SELECT voice_sample_r2, intro_mime, intro_status, voice_seconds FROM hf_hosts WHERE uid=?1")
    .bind(uid).first<{ voice_sample_r2: string | null; intro_mime: string | null; intro_status: string | null; voice_seconds: number | null }>().catch(() => null);
  return approveIntroRow(env, uid, h);
}
async function approveIntroRow(env: Env, uid: string, h: { voice_sample_r2: string | null; intro_mime: string | null; intro_status: string | null; voice_seconds: number | null } | null): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!h || h.intro_status !== "pending" || !h.voice_sample_r2) return { ok: false, error: "no_pending_intro" };
  const src = await env.VERIFICATION.get(h.voice_sample_r2);
  if (!src) return { ok: false, error: "intro_file_missing" };
  const mime = h.intro_mime || src.httpMetadata?.contentType || "audio/mp4";
  const ext = h.voice_sample_r2.split(".").pop() || "m4a";
  const now = Date.now();
  const pubKey = `hf/hosts/${uid}/intro-${now}.${ext}`;
  await env.BLOBS.put(pubKey, await src.arrayBuffer(), { httpMetadata: { contentType: mime, cacheControl: "public, max-age=3600" } });
  const prev = (await env.DB_META.prepare("SELECT r2_key FROM hf_host_media WHERE uid=?1 AND kind=?2 AND status='active'").bind(uid, INTRO_MEDIA_KIND).all<{ r2_key: string }>()).results ?? [];
  try {
    await env.DB_META.batch([
      env.DB_META.prepare("UPDATE hf_host_media SET status='superseded' WHERE uid=?1 AND kind=?2 AND status='active'").bind(uid, INTRO_MEDIA_KIND),
      env.DB_META.prepare("INSERT INTO hf_host_media (id, uid, kind, r2_key, caption, sort, status, created_at) VALUES (?1,?2,?3,?4,?5,0,'active',?6)")
        .bind(crypto.randomUUID(), uid, INTRO_MEDIA_KIND, pubKey, introCaption(h.voice_seconds, mime), now),
      env.DB_META.prepare("UPDATE hf_hosts SET intro_status='approved', updated_at=?3 WHERE uid=?1 AND voice_sample_r2=?2 AND intro_status='pending'").bind(uid, h.voice_sample_r2, now),
    ]);
  } catch (e) {
    await env.BLOBS.delete(pubKey).catch(() => {});
    throw e;
  }
  for (const r of prev) if (r.r2_key !== pubKey) await env.BLOBS.delete(r.r2_key).catch(() => {});
  return { ok: true };
}

async function notifyHost(env: Env, adminUid: string, uid: string, msg: string, route: string): Promise<boolean> {
  try {
    const phone = await verifiedWhatsAppNumber(env, uid);
    if (phone) return (await sendWhatsAppText(env, phone, msg)).ok;
  } catch (e) {
    await trackException(env, e, { uid: adminUid, route, handled: true, app_name: APP, extra: { area: "hf_hosts_admin", step: "whatsapp" } });
  }
  return false;
}

// POST /api/admin/hf/hosts/:uid/intro { decision: approve|reject, reason? }
async function decideIntro(req: Request, env: Env, uid: string): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const b = await readJson(req);
  const decision = String(b.decision || "");
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";
  if (decision !== "approve" && decision !== "reject") return err(400, "bad_decision");
  if (decision === "reject" && !reason) return err(400, "reason_required");
  const h = await env.DB_META.prepare("SELECT voice_sample_r2, intro_mime, intro_status, voice_seconds FROM hf_hosts WHERE uid=?1")
    .bind(uid).first<{ voice_sample_r2: string | null; intro_mime: string | null; intro_status: string | null; voice_seconds: number | null }>();
  if (!h) return err(404, "not_found");
  if (h.intro_status !== "pending") return err(409, "bad_state", { introStatus: h.intro_status });
  const now = Date.now();
  let notified = false;
  if (decision === "approve") {
    const r = await approveIntroRow(env, uid, h);
    if (!r.ok) return err(r.error === "intro_file_missing" ? 410 : 409, r.error);
  } else {
    const r = await env.DB_META.prepare("UPDATE hf_hosts SET intro_status='rejected', updated_at=?3 WHERE uid=?1 AND voice_sample_r2=?2 AND intro_status='pending'").bind(uid, h.voice_sample_r2, now).run();
    if (!r.meta?.changes) return err(409, "bad_state");
    notified = await notifyHost(env, a.uid, uid, `Please re-record your introduction: ${reason}`, "/api/admin/hf/hosts/intro");
  }
  await audit(env, a.uid, `intro_${decision}`, uid, { reason });
  void track(env, uid, "hf_host_intro_reviewed", APP, { area: "hf_hosts_admin", decision });
  return json({ ok: true, introStatus: decision === "approve" ? "approved" : "rejected", notified });
}

async function listHosts(req: Request, env: Env): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const st = new URL(req.url).searchParams.get("status") || "pending_review";
  if (!STATUSES.includes(st)) return err(400, "bad_status");
  const rows = (await env.DB_META.prepare(`${HOST_SQL} WHERE h.status = ?1 ORDER BY h.updated_at DESC LIMIT 100`).bind(st).all<HostRow>()).results ?? [];
  return json({ ok: true, items: rows.map((h) => hostJson(env, h)) });
}

async function hostDetail(req: Request, env: Env, uid: string): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const h = await env.DB_META.prepare(`${HOST_SQL} WHERE h.uid = ?1`).bind(uid).first<HostRow>();
  if (!h) return err(404, "not_found");
  const [media, kyc, selfie, payout] = await Promise.all([
    env.DB_META.prepare("SELECT id, kind, r2_key, caption, transcript_json, sort FROM hf_host_media WHERE uid=?1 AND status='active' ORDER BY kind, sort").bind(uid)
      .all<{ id: string; kind: string; r2_key: string; caption: string | null; transcript_json: string | null; sort: number }>(),
    env.DB_META.prepare("SELECT name_enc, gender, aadhaar_last4, age_ok, photo_r2_key, verified_at FROM hf_kyc WHERE uid=?1").bind(uid)
      .first<{ name_enc: string | null; gender: string | null; aadhaar_last4: string | null; age_ok: number; photo_r2_key: string | null; verified_at: number | null }>(),
    env.DB_META.prepare("SELECT id, review_status, review_reason, created_at FROM hf_selfie WHERE uid=?1 ORDER BY created_at DESC LIMIT 1").bind(uid)
      .first<{ id: string; review_status: string; review_reason: string | null; created_at: number }>(),
    env.DB_META.prepare("SELECT name_match, upi_verified, account_last4, verified_at FROM hf_payout WHERE uid=?1").bind(uid)
      .first<{ name_match: number; upi_verified: number; account_last4: string | null; verified_at: number | null }>(),
  ]);
  await audit(env, a.uid, "view", uid, {});
  const base = mediaBase(env);
  const live = (media.results ?? []).find((m) => m.kind === INTRO_MEDIA_KIND);
  const intro = h.voice_sample_r2 && h.intro_status
    ? {
        url: await signIntro(env, a.uid, uid, h.voice_sample_r2, h.intro_mime || "audio/mp4"), urlExpiresInS: INTRO_URL_TTL_MS / 1000,
        seconds: h.voice_seconds, mime: h.intro_mime, status: introStatusOf(h.intro_status), uploadedAt: h.intro_uploaded_at,
        transcript: h.intro_transcript, flags: parseStoredFlags(h.intro_flags_json),
      }
    : null;
  return json({
    ok: true,
    host: hostJson(env, h),
    intro,
    liveIntroUrl: live ? `${base}/${live.r2_key}` : null,
    media: (media.results ?? []).map((m) => ({
      id: m.id, kind: m.kind, url: `${base}/${m.r2_key}`, caption: m.caption, sort: m.sort,
      transcript: m.transcript_json ? arr(m.transcript_json) : undefined,
    })),
    kyc: {
      aadhaarDone: !!kyc?.verified_at, name: await tryDecryptPii(env, kyc?.name_enc), gender: kyc?.gender ?? null, last4: kyc?.aadhaar_last4 ?? null,
      ageOk: !!kyc?.age_ok, hasPhoto: !!kyc?.photo_r2_key,
      selfie: selfie ? { id: selfie.id, status: selfie.review_status, reason: selfie.review_reason, at: selfie.created_at } : null,
      payout: payout ? { nameMatch: !!payout.name_match, upiVerified: !!payout.upi_verified, accountLast4: payout.account_last4 } : null,
    },
  });
}

function slugBase(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "host";
}
async function uniqueSlug(env: Env, name: string, uid: string): Promise<string> {
  const base = slugBase(name);
  for (let i = 0; i < 6; i++) {
    const cand = i === 0 ? base : `${base}-${(crypto.randomUUID().replace(/-/g, "").slice(0, 3 + i))}`;
    const hit = await env.DB_META.prepare("SELECT uid FROM hf_hosts WHERE slug=?1 AND uid<>?2").bind(cand, uid).first();
    if (!hit) return cand;
  }
  return `${base}-${uid.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase()}`;
}

async function decide(req: Request, env: Env, uid: string): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const b = await readJson(req);
  const decision = String(b.decision || "");
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";
  if (!["approve", "reject", "pause"].includes(decision)) return err(400, "bad_decision");
  if (decision !== "approve" && !reason) return err(400, "reason_required");
  const h = await env.DB_META.prepare("SELECT uid, slug, status, display_name FROM hf_hosts WHERE uid=?1").bind(uid).first<{ uid: string; slug: string | null; status: string; display_name: string | null }>();
  if (!h) return err(404, "not_found");
  const now = Date.now();
  let msg = "";
  if (decision === "approve") {
    if (!["pending_review", "paused", "rejected"].includes(h.status)) return err(409, "bad_state", { status: h.status });
    const [selfie, payout, media] = await Promise.all([
      env.DB_META.prepare("SELECT review_status FROM hf_selfie WHERE uid=?1 ORDER BY created_at DESC LIMIT 1").bind(uid).first<{ review_status: string }>(),
      env.DB_META.prepare("SELECT name_match FROM hf_payout WHERE uid=?1").bind(uid).first<{ name_match: number }>(),
      env.DB_META.prepare("SELECT COUNT(*) AS n FROM hf_host_media WHERE uid=?1 AND status='active' AND kind IN ('profile','gallery')").bind(uid).first<{ n: number }>(),
    ]);
    const missing: string[] = [];
    if (selfie?.review_status !== "approved") missing.push("selfie_not_approved");
    if (!payout?.name_match) missing.push("payout_name_mismatch");
    if (!media?.n) missing.push("no_media");
    const ih = await env.DB_META.prepare("SELECT intro_status FROM hf_hosts WHERE uid=?1").bind(uid).first<{ intro_status: string | null }>();
    if (h.status === "pending_review" && ih?.intro_status !== "pending" && ih?.intro_status !== "approved") missing.push("no_intro");
    if (missing.length) return err(409, "not_ready", { missing });
    // [HF-VOICE-INTRO-1] approving the profile also approves a pending voice intro (rejecting the profile leaves it as is)
    if (ih?.intro_status === "pending") {
      const ir = await approvePendingIntro(env, uid);
      if (!ir.ok) return err(ir.error === "intro_file_missing" ? 410 : 409, ir.error);
      await audit(env, a.uid, "intro_approve", uid, { via: "profile_approve" });
    }
    const slug = h.slug || (await uniqueSlug(env, h.display_name || "host", uid));
    await env.DB_META.prepare("UPDATE hf_hosts SET status='live', slug=?2, live_at=COALESCE(live_at,?3), review_note=NULL, reviewed_by=?4, reviewed_at=?3, updated_at=?3 WHERE uid=?1")
      .bind(uid, slug, now, a.uid).run();
    msg = "Good news! Your profile is now live. People can find you and talk to you. Thank you for joining us.";
  } else {
    const to = decision === "reject" ? "rejected" : "paused";
    await env.DB_META.prepare("UPDATE hf_hosts SET status=?2, review_note=?3, reviewed_by=?4, reviewed_at=?5, updated_at=?5 WHERE uid=?1")
      .bind(uid, to, reason, a.uid, now).run();
    msg = decision === "reject"
      ? `Your profile was not approved yet. Reason: ${reason}. You can fix this and send it again.`
      : `Your profile is paused for now. Reason: ${reason}. Please write to our support team if you have questions.`;
  }
  await audit(env, a.uid, decision, uid, { reason, from: h.status });
  const notified = await notifyHost(env, a.uid, uid, msg, "/api/admin/hf/hosts/decision");
  return json({ ok: true, status: decision === "approve" ? "live" : decision === "reject" ? "rejected" : "paused", notified });
}

async function listAvatars(req: Request, env: Env): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const rows = (await env.DB_META.prepare("SELECT id, image_key, gender, age_band, look, status, taken_by_uid, created_at FROM hf_avatars ORDER BY created_at DESC LIMIT 500")
    .all<{ id: string; image_key: string; gender: string; age_band: string; look: string; status: string; taken_by_uid: string | null; created_at: number }>()).results ?? [];
  const jobs = (await env.DB_META.prepare("SELECT id, status, error, created_at FROM hf_media_jobs WHERE kind='avatar_batch' ORDER BY created_at DESC LIMIT 5")
    .all<{ id: string; status: string; error: string | null; created_at: number }>()).results ?? [];
  const base = mediaBase(env);
  return json({
    ok: true,
    items: rows.map((r) => ({ id: r.id, url: `${base}/${r.image_key}`, gender: r.gender, age: r.age_band, look: r.look, status: r.status, taken: !!r.taken_by_uid, createdAt: r.created_at })),
    jobs,
  });
}

async function generateAvatars(req: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const b = await readJson(req);
  const count = Math.floor(Number(b.count));
  const gender = String(b.gender || ""), age = String(b.age || ""), look = String(b.look || "");
  if (!(count >= 1 && count <= 12)) return err(400, "bad_count");
  if (!GENDERS.includes(gender)) return err(400, "bad_gender");
  if (!AGES.includes(age)) return err(400, "bad_age");
  if (!LOOKS.includes(look)) return err(400, "bad_look");
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB_META.prepare("INSERT INTO hf_media_jobs (id, uid, kind, status, stages_json, created_at, updated_at) VALUES (?1,?2,'avatar_batch','queued',?3,?4,?4)")
    .bind(id, a.uid, JSON.stringify({ count, gender, age, look }), now).run();
  try {
    const wf = (env as any).AVATAR_BATCH;
    if (!wf) throw new Error("AVATAR_BATCH binding missing");
    const inst = await wf.create({ id, params: { count, gender, age, look, jobId: id } });
    await env.DB_META.prepare("UPDATE hf_media_jobs SET instance_id=?2, status='running', updated_at=?3 WHERE id=?1").bind(id, inst?.id ?? id, Date.now()).run();
  } catch (e) {
    await env.DB_META.prepare("UPDATE hf_media_jobs SET status='failed', error=?2, updated_at=?3 WHERE id=?1").bind(id, String((e as Error)?.message || e).slice(0, 300), Date.now()).run();
    await trackException(env, e, { uid: a.uid, route: "/api/admin/hf/avatars/generate", handled: true, app_name: APP, extra: { area: "hf_hosts_admin", step: "workflow_create" } });
    return err(502, "workflow_unavailable", { jobId: id });
  }
  await audit(env, a.uid, "avatars_generate", id, { count, gender, age, look });
  return json({ ok: true, jobId: id });
}

async function fillAvatars(req: Request, env: Env): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const b = await readJson(req);
  const target = b.target === undefined || b.target === null ? 4 : Math.floor(Number(b.target));
  if (!(target >= 1 && target <= 8)) return err(400, "bad_target");
  const running = await env.DB_META.prepare(
    "SELECT id FROM hf_media_jobs WHERE kind='avatar_batch' AND status IN ('queued','running') AND stages_json LIKE '%\"plan\"%' AND updated_at>?1 LIMIT 1",
  ).bind(Date.now() - 2 * 3600 * 1000).first<{ id: string }>();
  if (running) return err(409, "fill_running", { jobId: running.id });
  const have = (await env.DB_META.prepare("SELECT gender, age_band, look, COUNT(*) AS n FROM hf_avatars WHERE status='active' GROUP BY gender, age_band, look")
    .all<{ gender: string; age_band: string; look: string; n: number }>()).results ?? [];
  const full = buildAvatarFillPlan(have, target);
  // Workflow accepts at most MAX_PLAN_TOTAL images per run; trim the tail (run fill again for the rest).
  const plan: AvatarPlanEntry[] = [];
  let total = 0;
  for (const e of full) {
    if (total + e.count > MAX_PLAN_TOTAL) break;
    plan.push(e); total += e.count;
  }
  if (plan.length === 0) return json({ ok: true, queued: 0 });
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB_META.prepare("INSERT INTO hf_media_jobs (id, uid, kind, status, stages_json, created_at, updated_at) VALUES (?1,?2,'avatar_batch','queued',?3,?4,?4)")
    .bind(id, a.uid, JSON.stringify({ plan, target, done: 0, total, failed: 0 }), now).run();
  try {
    const wf = (env as any).AVATAR_BATCH;
    if (!wf) throw new Error("AVATAR_BATCH binding missing");
    const inst = await wf.create({ id, params: { jobId: id, count: 0, gender: "woman", age: "30s", look: "casual", plan } });
    await env.DB_META.prepare("UPDATE hf_media_jobs SET instance_id=?2, status='running', updated_at=?3 WHERE id=?1").bind(id, inst?.id ?? id, Date.now()).run();
  } catch (e) {
    await env.DB_META.prepare("UPDATE hf_media_jobs SET status='failed', error=?2, updated_at=?3 WHERE id=?1").bind(id, String((e as Error)?.message || e).slice(0, 300), Date.now()).run();
    await trackException(env, e, { uid: a.uid, route: "/api/admin/hf/avatars/fill", handled: true, app_name: APP, extra: { area: "hf_hosts_admin", step: "workflow_create" } });
    return err(502, "workflow_unavailable", { jobId: id });
  }
  await audit(env, a.uid, "avatars_fill", id, { target, entries: plan.length, images: planTotal(plan) });
  return json({ ok: true, jobId: id, queued: total });
}

async function retireAvatar(req: Request, env: Env, id: string): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const r = await env.DB_META.prepare("UPDATE hf_avatars SET status='retired' WHERE id=?1").bind(id).run();
  if (!r.meta?.changes) return err(404, "not_found");
  await audit(env, a.uid, "avatar_retire", id, {});
  return json({ ok: true });
}

export async function hfHostsAdminRoute(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const p = new URL(req.url).pathname, m = req.method;
  if (!p.startsWith("/api/admin/hf/hosts") && !p.startsWith("/api/admin/hf/avatars")) return null;
  try {
    if (p === "/api/admin/hf/hosts" && m === "GET") return await listHosts(req, env);
    if (p === "/api/admin/hf/hosts/intro-media" && m === "GET") return await introMedia(req, env);
    let x = p.match(/^\/api\/admin\/hf\/hosts\/([A-Za-z0-9._:-]{1,128})$/);
    if (x && m === "GET") return await hostDetail(req, env, x[1]);
    x = p.match(/^\/api\/admin\/hf\/hosts\/([A-Za-z0-9._:-]{1,128})\/decision$/);
    if (x && m === "POST") return await decide(req, env, x[1]);
    x = p.match(/^\/api\/admin\/hf\/hosts\/([A-Za-z0-9._:-]{1,128})\/intro$/);
    if (x && m === "POST") return await decideIntro(req, env, x[1]);
    if (p === "/api/admin/hf/avatars" && m === "GET") return await listAvatars(req, env);
    if (p === "/api/admin/hf/avatars/generate" && m === "POST") return await generateAvatars(req, env, ctx);
    if (p === "/api/admin/hf/avatars/fill" && m === "POST") return await fillAvatars(req, env);
    x = p.match(/^\/api\/admin\/hf\/avatars\/([A-Za-z0-9._:-]{1,128})\/retire$/);
    if (x && m === "POST") return await retireAvatar(req, env, x[1]);
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: APP, extra: { area: "hf_hosts_admin" } });
    return err(500, "internal");
  }
}
