// [HF-CREATOR-SPACES-1 2026-10-24] Creator types + Women-only / LGBTQ+ spaces. One authority for "video KYC" and for "is this space creator qualified".
//   video KYC = Aadhaar verified (hf_kyc.verified_at) AND the LATEST hf_selfie is 'approved' (pending / rejected = not verified).
//   space creator qualified = WhatsApp verified + Aadhaar verified + (women: gender F | lgbtq: gender T or declared) + latest selfie approved.
// [HF-CREATOR-BADGES-1 2026-10-24] Stacked badges: phone + channel + video KYC + space. ONE go-live rule (canGoLive): approved channel OR video KYC; a space creator additionally needs her space qualification.
// Never put gender or the declaration into telemetry or a public object.
import type { Env } from "../types";
import { isPhoneVerified } from "./hf_public_verification";
import { trackException } from "../hooks";
import { BRAND } from "./brand";
import { latestLaneSelfie, type LaneSelfieStatus } from "./hf_lanes";

export type CreatorKind = "channel" | "women" | "lgbtq";
export type SpaceName = "women" | "lgbtq";

export const parseCreatorKind = (v: unknown): CreatorKind | null => (v === "channel" || v === "women" || v === "lgbtq" ? v : null);
export const parseSpace = (v: unknown): SpaceName | null => { const s = typeof v === "string" ? v.trim().toLowerCase() : ""; return s === "women" || s === "lgbtq" ? s : null; };

/** SQL predicate (1/0) for "video KYC verified" of the uid expression (e.g. `h.uid`). No join, safe in a list query. */
export function videoKycSql(uidExpr: string): string {
  return `(EXISTS (SELECT 1 FROM hf_kyc vk WHERE vk.uid=${uidExpr} AND vk.verified_at IS NOT NULL) AND COALESCE((SELECT vs.review_status FROM hf_selfie vs WHERE vs.uid=${uidExpr} ORDER BY vs.created_at DESC, vs.id DESC LIMIT 1),'')='approved')`;
}

/** Public tag of a host row: 'women' | 'lgbtq' (only when the creator agreed to the public tag) | null. */
export function spaceOfRow(r: { women_lane?: number | null; lgbtq_lane?: number | null; lgbtq_public?: number | null }): SpaceName | null {
  if (r.women_lane === 1) return "women";
  if (r.lgbtq_lane === 1 && r.lgbtq_public === 1) return "lgbtq";
  return null;
}

export interface SpaceFacts {
  whatsappVerified: boolean; aadhaarVerified: boolean; gender: "F" | "M" | "T" | null;
  selfie: { status: LaneSelfieStatus; reason: string | null }; lgbtqDeclared: boolean; videoKycVerified: boolean;
}

export async function spaceFacts(env: Env, uid: string): Promise<SpaceFacts> {
  const [wa, k, selfie, decl] = await Promise.all([
    isPhoneVerified(env, uid),
    env.DB_META.prepare("SELECT gender, verified_at FROM hf_kyc WHERE uid=?1").bind(uid).first<{ gender: string | null; verified_at: number | null }>(),
    latestLaneSelfie(env, uid),
    env.DB_META.prepare("SELECT declared_at FROM hf_lane_access WHERE uid=?1 AND lane='lgbtq'").bind(uid).first<{ declared_at: number | null }>(),
  ]);
  const aadhaarVerified = !!k?.verified_at;
  const gender = k?.gender === "F" || k?.gender === "M" || k?.gender === "T" ? k.gender : null;
  return { whatsappVerified: wa, aadhaarVerified, gender, selfie, lgbtqDeclared: decl?.declared_at != null, videoKycVerified: aadhaarVerified && selfie.status === "approved" };
}

export async function videoKycVerified(env: Env, uid: string): Promise<boolean> {
  const r = await env.DB_META.prepare(`SELECT ${videoKycSql("?1")} AS ok`).bind(uid).first<{ ok: number }>();
  return Number(r?.ok) === 1;
}

/** Pure qualification matrix for a space creator of `kind`. */
export function qualifiedFor(kind: SpaceName, f: SpaceFacts): boolean {
  if (!f.whatsappVerified || !f.aadhaarVerified || f.selfie.status !== "approved") return false;
  return kind === "women" ? f.gender === "F" : f.gender === "T" || f.lgbtqDeclared;
}

export async function creatorKindOf(env: Env, uid: string): Promise<CreatorKind | null> {
  const r = await env.DB_META.prepare("SELECT creator_kind FROM hf_hosts WHERE uid=?1").bind(uid).first<{ creator_kind: string | null }>();
  return r ? (parseCreatorKind(r.creator_kind) ?? "channel") : null;
}

// ── [HF-CREATOR-BADGES-1] caller level + space derivation ────────────────────────────────────────────────────────
export type CallerLevel = "everyone" | "video_kyc";
export const parseCallerLevel = (v: unknown): CallerLevel | null => (v === "everyone" || v === "video_kyc" ? v : null);

export interface HostSpaceCols { women_lane?: number | null; lgbtq_lane?: number | null; creator_kind?: string | null; caller_level?: string | null }

/** The space a host row belongs to. Derived from women_lane / lgbtq_lane; creator_kind (legacy) is read only when both lanes are off. */
export function spaceOfHost(r: HostSpaceCols): SpaceName | null {
  if (r.women_lane === 1) return "women";
  if (r.lgbtq_lane === 1) return "lgbtq";
  if (r.creator_kind === "women" || r.creator_kind === "lgbtq") return r.creator_kind;
  return null;
}

/** Effective "who can call you": space creators are always video_kyc. */
export function effectiveCallerLevel(r: HostSpaceCols): CallerLevel {
  return spaceOfHost(r) || r.caller_level === "video_kyc" ? "video_kyc" : "everyone";
}

/** SQL (1/0): host row `h` has an approved channel. No join, safe in a list query. */
export function channelVerifiedSql(uidExpr: string): string {
  return `EXISTS (SELECT 1 FROM hf_channels hc WHERE hc.host_uid=${uidExpr} AND hc.status='approved')`;
}

/** True when this caller must be refused because the host takes only video-KYC customers and the caller has no full video KYC. */
export async function callerKycBlocked(env: Env, callerUid: string, host: HostSpaceCols): Promise<boolean> {
  if (effectiveCallerLevel(host) !== "video_kyc") return false;
  return !(await videoKycVerified(env, callerUid));
}
export const CALLER_KYC_ERROR = "video_kyc_required_caller";
export const CALLER_KYC_MESSAGE = "This creator takes calls from customers with full video KYC. Verify yours to continue.";

// ── [HF-CREATOR-BADGES-1] the go-live rule: ONE authority ────────────────────────────────────────────────────────
export interface GoLiveFacts { channel: boolean; videoKyc: boolean; space: SpaceName | null; spaceQualified: boolean }

/** Pure rule. missing: 'channel_or_video_kyc' (neither badge), 'space_video_kyc' (space creator not qualified). */
export function canGoLive(f: GoLiveFacts): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!f.channel && !f.videoKyc) missing.push("channel_or_video_kyc");
  if (f.space && !f.spaceQualified) missing.push("space_video_kyc");
  return { ok: missing.length === 0, missing };
}

/** Publication / approve / submit blocker codes for the go-live rule. */
export function goLiveBlockers(f: GoLiveFacts, opts: { requireBasis?: boolean } = {}): string[] {
  const out: string[] = [];
  if (opts.requireBasis !== false && !f.channel && !f.videoKyc) out.push("verification_required");
  if (f.space && !f.spaceQualified) out.push("video_kyc_required");
  return out;
}

export interface CreatorBadges {
  badges: { phone: boolean; channel: boolean; videoKyc: boolean; space: SpaceName | null };
  canGoLive: boolean; missing: string[];
  facts: SpaceFacts; host: { status: string; creator_kind: string | null; caller_level: string | null; women_lane: number; lgbtq_lane: number } | null;
}

/** Badge matrix + go-live verdict for one uid. 3 small reads in parallel, no N+1. */
export async function creatorBadges(env: Env, uid: string): Promise<CreatorBadges> {
  const [f, host, ch] = await Promise.all([
    spaceFacts(env, uid),
    env.DB_META.prepare("SELECT status, creator_kind, caller_level, women_lane, lgbtq_lane FROM hf_hosts WHERE uid=?1").bind(uid)
      .first<{ status: string; creator_kind: string | null; caller_level: string | null; women_lane: number; lgbtq_lane: number }>(),
    env.DB_META.prepare("SELECT COUNT(*) AS c FROM hf_channels WHERE host_uid=?1 AND status='approved'").bind(uid).first<{ c: number }>(),
  ]);
  const space = host ? spaceOfHost(host) : null;
  const channel = Number(ch?.c ?? 0) > 0;
  const g = canGoLive({ channel, videoKyc: f.videoKycVerified, space, spaceQualified: space ? qualifiedFor(space, f) : true });
  return { badges: { phone: f.whatsappVerified, channel, videoKyc: f.videoKycVerified, space }, canGoLive: g.ok, missing: g.missing, facts: f, host: host ?? null };
}

/** Go-live facts only (what syncHostState / blockers need). Lean: no WhatsApp / gender reads unless she is in a space. A failing
 *  video-KYC read sets `kycUnknown` (and videoKyc false) so a caller never demotes on a read error. */
export async function goLiveFacts(env: Env, uid: string): Promise<GoLiveFacts & { hasHost: boolean; kycUnknown: boolean }> {
  const [host, ch] = await Promise.all([
    env.DB_META.prepare("SELECT creator_kind, women_lane, lgbtq_lane FROM hf_hosts WHERE uid=?1").bind(uid).first<{ creator_kind: string | null; women_lane: number; lgbtq_lane: number }>(),
    env.DB_META.prepare("SELECT COUNT(*) AS c FROM hf_channels WHERE host_uid=?1 AND status='approved'").bind(uid).first<{ c: number }>(),
  ]);
  const space = host ? spaceOfHost(host) : null;
  let videoKyc = false, kycUnknown = false;
  try { videoKyc = await videoKycVerified(env, uid); } catch (e) { kycUnknown = true; await trackException(env, e, { uid, route: "hf_spaces.goLiveFacts", handled: true, app_name: BRAND.slug, extra: { area: "hf_spaces" } }).catch(() => undefined); }
  const spaceQualifiedNow = space ? qualifiedFor(space, await spaceFacts(env, uid)) : true;
  return { channel: Number(ch?.c ?? 0) > 0, videoKyc, space, spaceQualified: spaceQualifiedNow, hasHost: !!host, kycUnknown };
}

/** Shared gate: is this uid's space creator fully qualified? Hosts who are not space creators (channel / no host row) are not
 *  subject to the space rules, so this returns true for them (nothing is blocked). `kind` (legacy) forces a space when given. */
export async function spaceQualified(env: Env, uid: string, kind?: CreatorKind | null): Promise<boolean> {
  const b = await creatorBadges(env, uid);
  const space = b.badges.space ?? (kind === "women" || kind === "lgbtq" ? kind : null);
  if (!space) return true;
  return qualifiedFor(space, b.facts);
}

export async function isSpaceCreator(env: Env, uid: string): Promise<boolean> {
  return (await creatorBadges(env, uid)).badges.space !== null;
}
