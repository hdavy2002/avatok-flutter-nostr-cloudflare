// [HF-CREATOR-SPACES-1 2026-10-24] Creator types + Women-only / LGBTQ+ spaces. Flag hfCreatorSpacesEnabled (off -> 404 not_enabled).
//   GET  /api/hf/spaces/me       -> { ok, kind:'channel'|'women'|'lgbtq'|null, whatsappVerified, aadhaarVerified, gender:'F'|'M'|'T'|null,
//                                     selfie:{status:'none'|'pending'|'approved'|'rejected', reason}, lgbtqDeclared, videoKycVerified, qualified,
//                                     hostStatus, minFollowers, minViews }
//   POST /api/hf/spaces/creator  { kind:'channel'|'women'|'lgbtq', declare?:true, acceptTerms?:true, publicTagConsent?:true } -> { ok, kind }
//        women  -> women_lane=1 (403 not_eligible when Aadhaar is already verified and gender != F)
//        lgbtq  -> publicTagConsent required (400 consent_required); unless Aadhaar gender is T: declare + acceptTerms (400 declare_required);
//                  lgbtq_lane=1, lgbtq_public=1
// Qualification (lib/hf_spaces.ts): WhatsApp + Aadhaar + (women F | lgbtq T-or-declared) + latest selfie approved. Telemetry never carries gender or the declaration.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackUser, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { emailFor } from "../lib/identity";
import { readConfig } from "./config";
import { ensureHostRow, minFollowersOf, minViewsOf, syncHostState } from "./hf_channels";
import { spaceFacts, qualifiedFor, parseCreatorKind, creatorKindOf, type CreatorKind } from "../lib/hf_spaces";

const APP = BRAND.slug;
const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ ok: false, error, ...extra }, status, NO_STORE);

function makeEmit(env: Env, ctx: ExecutionContext | undefined, uid: string) {
  return (event: string, props: Record<string, unknown> = {}): void => {
    const p = (async () => {
      const email = await emailFor(env, uid).catch(() => null);
      await trackUser(env, uid, email, event, APP, { area: "hf_spaces", ...props });
    })().catch((e) => trackException(env, e, { uid, route: "hf_spaces.emit", handled: true, app_name: APP, extra: { area: "hf_spaces", event } }).catch(() => undefined));
    if (ctx) ctx.waitUntil(p);
  };
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 2_000) return null;
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
}

async function me(env: Env, uid: string, cfg: Record<string, unknown>): Promise<Response> {
  const [f, host, approvedChannels] = await Promise.all([
    spaceFacts(env, uid),
    env.DB_META.prepare("SELECT status, creator_kind FROM hf_hosts WHERE uid=?1").bind(uid).first<{ status: string; creator_kind: string | null }>(),
    env.DB_META.prepare("SELECT COUNT(*) AS c FROM hf_channels WHERE host_uid=?1 AND status='approved'").bind(uid).first<{ c: number }>(),
  ]);
  const kind: CreatorKind | null = host ? (parseCreatorKind(host.creator_kind) ?? "channel") : null;
  const qualified = kind === "women" || kind === "lgbtq" ? qualifiedFor(kind, f) : kind === "channel" ? Number(approvedChannels?.c ?? 0) > 0 : false;
  return json({
    ok: true, kind, whatsappVerified: f.whatsappVerified, aadhaarVerified: f.aadhaarVerified, gender: f.gender, selfie: f.selfie,
    lgbtqDeclared: f.lgbtqDeclared, videoKycVerified: f.videoKycVerified, qualified, hostStatus: host?.status ?? null,
    minFollowers: minFollowersOf(cfg), minViews: minViewsOf(cfg),
  }, 200, NO_STORE);
}

async function setCreator(req: Request, env: Env, ctx: ExecutionContext | undefined, uid: string): Promise<Response> {
  const lim = await rateLimit(env, `hfspace:${uid}`, 20, 3600);
  if (lim) return lim;
  const b = await readBody(req);
  const kind = parseCreatorKind(b?.kind);
  if (!b || !kind) return err(400, "invalid_field", { field: "kind", message: "Pick channel, women or lgbtq." });
  const f = await spaceFacts(env, uid);
  const prev = await creatorKindOf(env, uid);
  const now = Date.now();
  let lanes = { women: 0, lgbtq: 0, pub: 0 };
  if (kind === "women") {
    if (f.aadhaarVerified && f.gender !== "F") return err(403, "not_eligible", { message: "The women-only channel is open to creators whose Aadhaar shows female." });
    lanes = { women: 1, lgbtq: 0, pub: 0 };
  } else if (kind === "lgbtq") {
    if (b.publicTagConsent !== true) return err(400, "consent_required", { field: "publicTagConsent", message: "Please agree that the LGBTQ+ channel tag is public on your profile, in search and on Google." });
    const aadhaarSaysT = f.aadhaarVerified && f.gender === "T";
    if (!aadhaarSaysT && !(b.declare === true && b.acceptTerms === true)) return err(400, "declare_required", { message: "Please tick the box to say this space is right for you and accept the LGBTQ+ space terms." });
    if (b.declare === true && b.acceptTerms === true) {
      await env.DB_META.prepare(
        `INSERT INTO hf_lane_access (uid, lane, verified_at, declared_at) VALUES (?1,'lgbtq',?2,?2)
         ON CONFLICT(uid, lane) DO UPDATE SET declared_at=COALESCE(hf_lane_access.declared_at, excluded.declared_at)`,
      ).bind(uid, now).run();
    }
    lanes = { women: 0, lgbtq: 1, pub: 1 };
  }
  await ensureHostRow(env, uid, now);
  const cur = await env.DB_META.prepare("SELECT status FROM hf_hosts WHERE uid=?1").bind(uid).first<{ status: string }>();
  const wasSpace = prev === "women" || prev === "lgbtq";
  if (kind !== "channel" && !wasSpace && (cur?.status === "live" || cur?.status === "approved")) {
    // A host who is already visible cannot become a space creator before her video KYC is approved.
    if (!qualifiedFor(kind, { ...f, lgbtqDeclared: f.lgbtqDeclared || (b.declare === true && b.acceptTerms === true) })) return err(409, "video_kyc_required", { message: "Finish your video KYC before starting this channel." });
  }
  if (kind === "channel") {
    // Back to a plain channel creator: drop the space lanes this flow set.
    await env.DB_META.prepare("UPDATE hf_hosts SET creator_kind='channel', women_lane=CASE WHEN ?2=1 THEN 0 ELSE women_lane END, lgbtq_lane=CASE WHEN ?2=1 THEN 0 ELSE lgbtq_lane END, lgbtq_public=CASE WHEN ?2=1 THEN 0 ELSE lgbtq_public END, updated_at=?3 WHERE uid=?1")
      .bind(uid, wasSpace ? 1 : 0, now).run();
    await syncHostState(env, uid, now);
  } else {
    await env.DB_META.prepare("UPDATE hf_hosts SET creator_kind=?2, women_lane=?3, lgbtq_lane=?4, lgbtq_public=?5, updated_at=?6 WHERE uid=?1")
      .bind(uid, kind, lanes.women, lanes.lgbtq, lanes.pub, now).run();
  }
  makeEmit(env, ctx, uid)("hf_space_creator_chosen", { kind });
  return json({ ok: true, kind }, 200, NO_STORE);
}

/** Returns null when the path is not ours so index.ts can fall through. */
export async function hfSpacesRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  const isMe = p === "/api/hf/spaces/me";
  const isCreator = p === "/api/hf/spaces/creator";
  if (!isMe && !isCreator) return null;
  if (isMe ? req.method !== "GET" : req.method !== "POST") return err(405, "method_not_allowed");
  try {
    const cfg = (await readConfig(env)) as unknown as Record<string, unknown>;
    if (cfg.hfCreatorSpacesEnabled !== true) return err(404, "not_enabled");
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error);
    return isMe ? await me(env, u.uid, cfg) : await setCreator(req, env, ctx, u.uid);
  } catch (e) {
    await trackException(env, e, { route: p, method: req.method, handled: true, app_name: APP, extra: { area: "hf_spaces" } });
    return err(500, "internal_error");
  }
}
