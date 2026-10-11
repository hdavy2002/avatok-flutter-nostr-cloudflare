// [HF-LANE-VERIFY-1 2026-10-09] HF protected lanes: caller verification. Rulebook HF-WOM-2, HF-LGBT-3, HF-KYC-5.
//   GET    /api/hf/lanes/me             -> { whatsappVerified, aadhaarVerified, gender:'F'|'M'|'T'|null,
//                                           lanes:{ women:{eligible,granted}, lgbtq:{declared,granted} } }
//   POST   /api/hf/lanes/women/join     -> { ok, lane:'women' } | 409 aadhaar_required | 403 not_eligible
//   POST   /api/hf/lanes/lgbtq/join     { declare:true, ack18:true } -> { ok, lane:'lgbtq' } | 400 declare_required | 409 aadhaar_required
//   DELETE /api/hf/lanes/:lane          -> { ok }   (leave the lane)
// Aadhaar itself is verified by the existing /api/hosts/kyc/* routes with role "lane_caller". Gated by hostKycEnabled (404 not_enabled).
// Telemetry never carries gender or the declaration beyond the lane name.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackUser, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { emailFor } from "../lib/identity";
import { readConfig } from "./config";
import { parseLane, laneEligible, womenEligible, WOMEN_NOT_ELIGIBLE_MESSAGE, getLaneAccess, latestLaneSelfie, type Lane } from "../lib/hf_lanes";

const APP = BRAND.slug;
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

function makeEmit(env: Env, ctx: ExecutionContext | undefined, uid: string) {
  return (event: string, props: Record<string, unknown> = {}): void => {
    const p = (async () => {
      const email = await emailFor(env, uid).catch(() => null);
      await trackUser(env, uid, email, event, APP, { area: "hf_lanes", ...props });
    })().catch(() => { /* best-effort */ });
    if (ctx) ctx.waitUntil(p);
  };
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 2_000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

async function kycFacts(env: Env, uid: string): Promise<{ aadhaarVerified: boolean; gender: "F" | "M" | "T" | null }> {
  const k = await env.DB_META.prepare("SELECT gender, verified_at FROM hf_kyc WHERE uid=?1").bind(uid)
    .first<{ gender: string | null; verified_at: number | null }>().catch(() => null);
  const g = k?.gender === "F" || k?.gender === "M" || k?.gender === "T" ? k.gender : null;
  return { aadhaarVerified: !!k?.verified_at, gender: g };
}

async function me(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const [kyc, cv, access, decl, selfie] = await Promise.all([
    kycFacts(env, u.uid),
    env.DB_META.prepare("SELECT phone_verified FROM contact_verification WHERE uid=?1").bind(u.uid).first<{ phone_verified: number }>().catch(() => null),
    getLaneAccess(env, u.uid),
    env.DB_META.prepare("SELECT declared_at FROM hf_lane_access WHERE uid=?1 AND lane='lgbtq'").bind(u.uid).first<{ declared_at: number | null }>().catch(() => null),
    latestLaneSelfie(env, u.uid),
  ]);
  return json({
    whatsappVerified: !!cv && Number(cv.phone_verified) === 1,
    aadhaarVerified: kyc.aadhaarVerified,
    gender: kyc.gender,
    lanes: {
      women: { eligible: laneEligible("women", kyc.aadhaarVerified, kyc.gender), granted: access.women },
      lgbtq: { declared: decl?.declared_at != null, granted: access.lgbtq && selfie.status === "approved", selfieStatus: selfie.status, selfieReason: selfie.reason },
    },
  }, 200, { "cache-control": "private, no-store" });
}

async function join(req: Request, env: Env, ctx: ExecutionContext | undefined, lane: Lane): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const emit = makeEmit(env, ctx, u.uid);
  const b = await readJson(req);
  const kyc = await kycFacts(env, u.uid);
  if (!kyc.aadhaarVerified) {
    emit("hf_lane_denied", { lane, reason: "aadhaar_required" });
    return err(409, "aadhaar_required", { message: "Please verify your Aadhaar first." });
  }
  if (lane === "women" && !womenEligible(kyc.gender)) {
    emit("hf_lane_denied", { lane, reason: "not_eligible" });
    return err(403, "not_eligible", { message: WOMEN_NOT_ELIGIBLE_MESSAGE });
  }
  let declaredAt: number | null = null;
  if (lane === "lgbtq") {
    if (b.declare !== true) return err(400, "declare_required", { message: "Please tick the box to say this space is right for you." });
    if (b.ack18 !== true) return err(400, "ack18_required", { message: "Please confirm that you are 18 or older." });
    declaredAt = Date.now();
  }
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT INTO hf_lane_access (uid, lane, verified_at, declared_at) VALUES (?1,?2,?3,?4)
     ON CONFLICT(uid, lane) DO UPDATE SET verified_at=excluded.verified_at, declared_at=COALESCE(excluded.declared_at, hf_lane_access.declared_at)`,
  ).bind(u.uid, lane, now, declaredAt).run();
  const access = await getLaneAccess(env, u.uid);
  const selfie = lane === "lgbtq" ? await latestLaneSelfie(env, u.uid) : null;
  emit("hf_lane_joined", { lane });
  return json({ ok: true, lane, granted: access[lane] && (!selfie || selfie.status === "approved"), ...(selfie ? { selfieStatus: selfie.status, selfieReason: selfie.reason } : {}) });
}

async function leave(req: Request, env: Env, ctx: ExecutionContext | undefined, lane: Lane): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  await env.DB_META.prepare("DELETE FROM hf_lane_access WHERE uid=?1 AND lane=?2").bind(u.uid, lane).run();
  makeEmit(env, ctx, u.uid)("hf_lane_left", { lane });
  return json({ ok: true });
}

/** Returns null when the path is not ours so index.ts can fall through. */
export async function hfLanesRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  if (!p.startsWith("/api/hf/lanes/")) return null;
  const m = req.method;
  try {
    const joinM = p.match(/^\/api\/hf\/lanes\/(women|lgbtq)\/join$/);
    const leaveM = p.match(/^\/api\/hf\/lanes\/(women|lgbtq)$/);
    const ours = (p === "/api/hf/lanes/me" && m === "GET") || (joinM && m === "POST") || (leaveM && m === "DELETE");
    if (!ours) return null;
    if ((await readConfig(env)).hostKycEnabled !== true) return err(404, "not_enabled");
    if (p === "/api/hf/lanes/me") return await me(req, env);
    if (joinM) return await join(req, env, ctx, parseLane(joinM[1]) as Lane);
    return await leave(req, env, ctx, parseLane(leaveM![1]) as Lane);
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: APP, extra: { area: "hf_lanes" } });
    return err(500, "internal_error");
  }
}
