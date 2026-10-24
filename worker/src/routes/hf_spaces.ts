// [HF-CREATOR-SPACES-1 2026-10-24] Creator types + Women-only / LGBTQ+ spaces. Flag hfCreatorSpacesEnabled (off -> 404 not_enabled).
//   GET  /api/hf/spaces/me       -> { ok, kind:'channel'|'women'|'lgbtq'|null, whatsappVerified, aadhaarVerified, gender:'F'|'M'|'T'|null,
//                                     selfie:{status:'none'|'pending'|'approved'|'rejected', reason}, lgbtqDeclared, videoKycVerified, qualified,
//                                     hostStatus, minFollowers, minViews }
//   POST /api/hf/spaces/creator  { kind:'channel'|'women'|'lgbtq', declare?:true, acceptTerms?:true, publicTagConsent?:true } -> { ok, kind }
//        women  -> women_lane=1 (403 not_eligible when Aadhaar is already verified and gender != F)
//        lgbtq  -> publicTagConsent required (400 consent_required); unless Aadhaar gender is T: declare + acceptTerms (400 declare_required);
//                  lgbtq_lane=1, lgbtq_public=1
// [HF-CREATOR-BADGES-1 2026-10-24] Stacked badges. /me also returns { badges:{phone,channel,videoKyc,space}, canGoLive, missing[], callerLevel, callerLevelLocked }.
//   POST /api/hf/spaces/space { space:'women'|'lgbtq'|null, declare?, acceptTerms?, publicTagConsent? } -> { ok, space }  (one at a time; null leaves; same errors as /creator)
//   POST /api/hf/spaces/caller-level { level:'everyone'|'video_kyc' } -> { ok, callerLevel } | 409 space_locked
//   /creator stays: kind 'channel' = no space, women / lgbtq = join that space. Space = women_lane / lgbtq_lane (creator_kind is legacy).
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
import { spaceFacts, qualifiedFor, parseCreatorKind, parseSpace, parseCallerLevel, creatorBadges, type SpaceName } from "../lib/hf_spaces";

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
  const b = await creatorBadges(env, uid);
  const f = b.facts;
  const space = b.badges.space;
  const kind = b.host ? (space ?? "channel") : null;
  const locked = space !== null;
  return json({
    ok: true, kind, whatsappVerified: f.whatsappVerified, aadhaarVerified: f.aadhaarVerified, gender: f.gender, selfie: f.selfie,
    lgbtqDeclared: f.lgbtqDeclared, videoKycVerified: f.videoKycVerified, qualified: b.host ? b.canGoLive : false, hostStatus: b.host?.status ?? null,
    minFollowers: minFollowersOf(cfg), minViews: minViewsOf(cfg),
    badges: b.badges, canGoLive: b.canGoLive, missing: b.missing,
    callerLevel: locked || b.host?.caller_level === "video_kyc" ? "video_kyc" : "everyone", callerLevelLocked: locked,
  }, 200, NO_STORE);
}

/** Join (space) or leave (null) a space. Shared by /space and /creator. Returns an error Response or null on success. */
async function applySpace(env: Env, uid: string, space: SpaceName | null, b: Record<string, unknown>, now: number): Promise<Response | { prev: SpaceName | null }> {
  const f = await spaceFacts(env, uid);
  const cur = await env.DB_META.prepare("SELECT status, creator_kind, women_lane, lgbtq_lane FROM hf_hosts WHERE uid=?1").bind(uid)
    .first<{ status: string; creator_kind: string | null; women_lane: number; lgbtq_lane: number }>();
  const prev: SpaceName | null = cur?.women_lane === 1 ? "women" : cur?.lgbtq_lane === 1 ? "lgbtq" : cur?.creator_kind === "women" || cur?.creator_kind === "lgbtq" ? cur.creator_kind : null;
  if (space === null) {
    await ensureHostRow(env, uid, now);
    await env.DB_META.prepare("UPDATE hf_hosts SET creator_kind='channel', women_lane=0, lgbtq_lane=0, lgbtq_public=0, updated_at=?2 WHERE uid=?1").bind(uid, now).run();
    return { prev };
  }
  let lanes = { women: 0, lgbtq: 0, pub: 0 };
  let declaredNow = false;
  if (space === "women") {
    if (f.aadhaarVerified && f.gender !== "F") return err(403, "not_eligible", { message: "The women-only channel is open to creators whose Aadhaar shows female." });
    lanes = { women: 1, lgbtq: 0, pub: 0 };
  } else {
    if (b.publicTagConsent !== true) return err(400, "consent_required", { field: "publicTagConsent", message: "Please agree that the LGBTQ+ channel tag is public on your profile, in search and on Google." });
    const aadhaarSaysT = f.aadhaarVerified && f.gender === "T";
    declaredNow = b.declare === true && b.acceptTerms === true;
    if (!aadhaarSaysT && !declaredNow) return err(400, "declare_required", { message: "Please tick the box to say this space is right for you and accept the LGBTQ+ space terms." });
    lanes = { women: 0, lgbtq: 1, pub: 1 };
  }
  if (!prev && (cur?.status === "live" || cur?.status === "approved")) {
    // A host who is already visible cannot join a space before her video KYC is approved.
    if (!qualifiedFor(space, { ...f, lgbtqDeclared: f.lgbtqDeclared || declaredNow })) return err(409, "video_kyc_required", { message: "Finish your video KYC before starting this channel." });
  }
  await ensureHostRow(env, uid, now);
  if (declaredNow) {
    await env.DB_META.prepare(
      `INSERT INTO hf_lane_access (uid, lane, verified_at, declared_at) VALUES (?1,'lgbtq',?2,?2)
       ON CONFLICT(uid, lane) DO UPDATE SET declared_at=COALESCE(hf_lane_access.declared_at, excluded.declared_at)`,
    ).bind(uid, now).run();
  }
  await env.DB_META.prepare("UPDATE hf_hosts SET creator_kind=?2, women_lane=?3, lgbtq_lane=?4, lgbtq_public=?5, updated_at=?6 WHERE uid=?1")
    .bind(uid, space, lanes.women, lanes.lgbtq, lanes.pub, now).run();
  return { prev };
}

async function setSpace(req: Request, env: Env, ctx: ExecutionContext | undefined, uid: string): Promise<Response> {
  const lim = await rateLimit(env, `hfspace:${uid}`, 20, 3600);
  if (lim) return lim;
  const b = await readBody(req);
  if (!b || !("space" in b) || (b.space !== null && !parseSpace(b.space))) return err(400, "invalid_field", { field: "space", message: "Pick women, lgbtq or null." });
  const space = b.space === null ? null : parseSpace(b.space);
  const now = Date.now();
  const r = await applySpace(env, uid, space, b, now);
  if (r instanceof Response) return r;
  await syncHostState(env, uid, now);
  const emit = makeEmit(env, ctx, uid);
  if (space) emit("hf_space_joined", { space }); else if (r.prev) emit("hf_space_left");
  return json({ ok: true, space }, 200, NO_STORE);
}

async function setCreator(req: Request, env: Env, ctx: ExecutionContext | undefined, uid: string): Promise<Response> {
  const lim = await rateLimit(env, `hfspace:${uid}`, 20, 3600);
  if (lim) return lim;
  const b = await readBody(req);
  const kind = parseCreatorKind(b?.kind);
  if (!b || !kind) return err(400, "invalid_field", { field: "kind", message: "Pick channel, women or lgbtq." });
  const now = Date.now();
  const space: SpaceName | null = kind === "channel" ? null : kind;
  const r = await applySpace(env, uid, space, b, now);
  if (r instanceof Response) return r;
  await syncHostState(env, uid, now);
  const emit = makeEmit(env, ctx, uid);
  emit("hf_space_creator_chosen", { kind });
  if (space) emit("hf_space_joined", { space }); else if (r.prev) emit("hf_space_left");
  return json({ ok: true, kind }, 200, NO_STORE);
}

async function setCallerLevel(req: Request, env: Env, ctx: ExecutionContext | undefined, uid: string): Promise<Response> {
  const lim = await rateLimit(env, `hfspace:${uid}`, 20, 3600);
  if (lim) return lim;
  const b = await readBody(req);
  const level = parseCallerLevel(b?.level);
  if (!level) return err(400, "invalid_field", { field: "level", message: "Pick everyone or video_kyc." });
  const now = Date.now();
  await ensureHostRow(env, uid, now);
  const badges = await creatorBadges(env, uid);
  if (badges.badges.space) return err(409, "space_locked", { message: "Space channels always take calls from video-KYC customers only.", callerLevel: "video_kyc" });
  await env.DB_META.prepare("UPDATE hf_hosts SET caller_level=?2, updated_at=?3 WHERE uid=?1").bind(uid, level, now).run();
  makeEmit(env, ctx, uid)("hf_caller_level_set", { level });
  return json({ ok: true, callerLevel: level }, 200, NO_STORE);
}

/** Returns null when the path is not ours so index.ts can fall through. */
export async function hfSpacesRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  const isMe = p === "/api/hf/spaces/me";
  const post = p === "/api/hf/spaces/creator" ? setCreator : p === "/api/hf/spaces/space" ? setSpace : p === "/api/hf/spaces/caller-level" ? setCallerLevel : null;
  if (!isMe && !post) return null;
  if (isMe ? req.method !== "GET" : req.method !== "POST") return err(405, "method_not_allowed");
  try {
    const cfg = (await readConfig(env)) as unknown as Record<string, unknown>;
    if (cfg.hfCreatorSpacesEnabled !== true) return err(404, "not_enabled");
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error);
    return isMe ? await me(env, u.uid, cfg) : await post!(req, env, ctx, u.uid);
  } catch (e) {
    await trackException(env, e, { route: p, method: req.method, handled: true, app_name: APP, extra: { area: "hf_spaces" } });
    return err(500, "internal_error");
  }
}
