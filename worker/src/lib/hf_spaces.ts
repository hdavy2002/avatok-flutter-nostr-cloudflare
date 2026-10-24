// [HF-CREATOR-SPACES-1 2026-10-24] Creator types + Women-only / LGBTQ+ spaces. One authority for "video KYC" and for "is this space creator qualified".
//   video KYC = Aadhaar verified (hf_kyc.verified_at) AND the LATEST hf_selfie is 'approved' (pending / rejected = not verified).
//   space creator qualified = WhatsApp verified + Aadhaar verified + (women: gender F | lgbtq: gender T or declared) + latest selfie approved.
// Never put gender or the declaration into telemetry or a public object.
import type { Env } from "../types";
import { isPhoneVerified } from "./hf_public_verification";
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

/** Shared gate: is this uid's space creator fully qualified? Hosts who are not space creators (channel / no host row) are not
 *  subject to the space rules, so this returns true for them (nothing is blocked). Use `isSpaceCreator` to tell them apart. */
export async function spaceQualified(env: Env, uid: string, kind?: CreatorKind | null): Promise<boolean> {
  const k = kind ?? (await creatorKindOf(env, uid));
  if (k !== "women" && k !== "lgbtq") return true;
  return qualifiedFor(k, await spaceFacts(env, uid));
}

export async function isSpaceCreator(env: Env, uid: string): Promise<boolean> {
  const k = await creatorKindOf(env, uid);
  return k === "women" || k === "lgbtq";
}
