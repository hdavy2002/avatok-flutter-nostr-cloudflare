// [HF-HOST-PLATFORM-1] Hello Fraands host review + avatar library admin API (ADMIN_UIDS only).
//   GET  /api/admin/hf/hosts?status=            list
//   GET  /api/admin/hf/hosts/:uid               host + media + KYC summary (selfie/Aadhaar photo via /api/admin/hf/kyc signed URLs)
//   POST /api/admin/hf/hosts/:uid/decision      { decision: approve|reject|pause, reason }
//   GET  /api/admin/hf/avatars                  avatar library
//   POST /api/admin/hf/avatars/generate         { count<=12, gender, age, look }  -> queues an avatar_batch job
//   POST /api/admin/hf/avatars/:id/retire
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { isAdminUid } from "../lib/preview";
import { tryDecryptPii } from "../lib/pii_crypto";
import { sendWhatsAppText } from "../lib/whatsapp_send";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";

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
  avatar_id: string | null; voice_seconds: number | null; gen_attempts: number; review_note: string | null; live_at: number | null;
  submitted_at: number | null; updated_at: number; avatar_key?: string | null;
};
const HOST_SQL = `SELECT h.*, a.image_key AS avatar_key FROM hf_hosts h LEFT JOIN hf_avatars a ON a.id = h.avatar_id`;

function hostJson(env: Env, h: HostRow) {
  return {
    uid: h.uid, slug: h.slug, status: h.status, displayName: h.display_name, about: h.about, tagline: h.tagline, quote: h.quote,
    aboutPolished: h.about_polished, languages: arr(h.languages_json), style: h.style, topics: arr(h.topics_json), conversationLang: h.conversation_lang,
    pricePerMin: h.price_per_min, hours: obj(h.hours_json), healthConsent: !!h.health_consent, womenLane: !!h.women_lane, lgbtqLane: !!h.lgbtq_lane,
    lgbtqPublic: !!h.lgbtq_public, avatarId: h.avatar_id, avatarUrl: h.avatar_key ? `${mediaBase(env)}/${h.avatar_key}` : null,
    voiceSeconds: h.voice_seconds, genAttempts: h.gen_attempts, reviewNote: h.review_note, liveAt: h.live_at,
    submittedAt: h.submitted_at, updatedAt: h.updated_at,
  };
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
  return json({
    ok: true,
    host: hostJson(env, h),
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
    if (missing.length) return err(409, "not_ready", { missing });
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
  let notified = false;
  try {
    const phone = await verifiedWhatsAppNumber(env, uid);
    if (phone) notified = (await sendWhatsAppText(env, phone, msg)).ok;
  } catch (e) {
    await trackException(env, e, { uid: a.uid, route: "/api/admin/hf/hosts/decision", handled: true, app_name: APP, extra: { area: "hf_hosts_admin", step: "whatsapp" } });
  }
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
    let x = p.match(/^\/api\/admin\/hf\/hosts\/([A-Za-z0-9._:-]{1,128})$/);
    if (x && m === "GET") return await hostDetail(req, env, x[1]);
    x = p.match(/^\/api\/admin\/hf\/hosts\/([A-Za-z0-9._:-]{1,128})\/decision$/);
    if (x && m === "POST") return await decide(req, env, x[1]);
    if (p === "/api/admin/hf/avatars" && m === "GET") return await listAvatars(req, env);
    if (p === "/api/admin/hf/avatars/generate" && m === "POST") return await generateAvatars(req, env, ctx);
    x = p.match(/^\/api\/admin\/hf\/avatars\/([A-Za-z0-9._:-]{1,128})\/retire$/);
    if (x && m === "POST") return await retireAvatar(req, env, x[1]);
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: APP, extra: { area: "hf_hosts_admin" } });
    return err(500, "internal");
  }
}
