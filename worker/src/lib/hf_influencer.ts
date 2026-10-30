// [HF-INFLUENCER-GATE-1 2026-10-29] Nobody is an influencer until a person approves them (Specs/HF-INFLUENCER-GATE-1.md, rulebook HF-GATE-1..6).
// ONE definition of "is influencer" and ONE definition of "what is still missing before she may apply", used by /api/hf/me, onboarding submit and admin approve.
import type { Env } from "../types";
import { isPhoneVerified } from "./hf_public_verification";
import { isSensitiveCategory } from "./hf_categories";
import { missingPhotosFor } from "./hf_user_photos";
import { REJECT_REASONS } from "./hf_intro_video";

/** An influencer has the dashboard and a public profile. 'paused' = a safety pause of a live influencer (she keeps the dashboard to withdraw). */
export const MISSING_TEXT: Readonly<Record<string, string>> = {
  profile_photo: "profile photo", cover_photo: "cover photo", whatsapp: "verified WhatsApp", social_or_aadhaar: "a verified social account or Aadhaar",
  aadhaar: "Aadhaar verification", intro_video: "intro video",
};

export const isInfluencer = (status: string | null | undefined): boolean => status === "live" || status === "paused";

export type MissingCode = "profile_photo" | "cover_photo" | "whatsapp" | "social_or_aadhaar" | "aadhaar" | "intro_video";

export async function photosReady(env: Env, uid: string): Promise<{ profile: boolean; cover: boolean }> {
  try {
    const m = await missingPhotosFor(env, uid);
    return { profile: !m.includes("profile"), cover: !m.includes("cover") };
  } catch { return { profile: false, cover: false }; }
}

/** What is still missing before she may send her application (G2). Order is stable. `categories` decides whether Aadhaar is mandatory;
 *  `hasVideo` overrides the stored-video lookup (submit/approve already know the exact video). All reads run in parallel. */
export async function applicationMissing(env: Env, uid: string, opts: { categories?: string[]; hasVideo?: boolean } = {}): Promise<MissingCode[]> {
  const [photos, wa, social, kyc, video] = await Promise.all([
    photosReady(env, uid),
    isPhoneVerified(env, uid),
    env.DB_META.prepare("SELECT 1 AS x FROM hf_channels WHERE host_uid=?1 AND status='approved' LIMIT 1").bind(uid).first().then((r) => !!r).catch(() => false),
    env.DB_META.prepare("SELECT verified_at FROM hf_kyc WHERE uid=?1").bind(uid).first<{ verified_at: number | null }>().then((r) => !!r?.verified_at).catch(() => false),
    opts.hasVideo !== undefined ? Promise.resolve(opts.hasVideo)
      : env.DB_META.prepare("SELECT 1 AS x FROM hf_intro_videos WHERE uid=?1 AND status IN ('draft','submitted','approved') AND deleted_at IS NULL LIMIT 1").bind(uid).first().then((r) => !!r).catch(() => false),
  ]);
  const out: MissingCode[] = [];
  if (!photos.profile) out.push("profile_photo");
  if (!photos.cover) out.push("cover_photo");
  if (!wa) out.push("whatsapp");
  const sensitive = (opts.categories ?? []).some(isSensitiveCategory);
  if (sensitive && !kyc) out.push("aadhaar");
  else if (!social && !kyc) out.push("social_or_aadhaar");
  if (!video) out.push("intro_video");
  return out;
}

export interface InfluencerApplicationState { status: "none" | "draft" | "submitted" | "rejected" | "approved"; rejectReason: string | null; missing: MissingCode[] }

/** The caller's application as /api/hf/me reports it. `missing` is [] for an influencer (nothing left to do). */
export async function influencerApplicationState(env: Env, uid: string, hostStatusIn: string | null | Promise<string | null>): Promise<InfluencerApplicationState> {
  // [HF-ME-SPEED-1] hostStatus may arrive as a promise so the caller can start this read before host_status is known.
  const appQ = env.DB_META.prepare("SELECT status, categories_json, reject_reasons_json, reject_note FROM hf_influencer_applications WHERE uid=?1 ORDER BY submitted_at DESC, id DESC LIMIT 1")
    .bind(uid).first<{ status: string; categories_json: string | null; reject_reasons_json: string | null; reject_note: string | null }>().catch(() => null);
  const hostStatus = await hostStatusIn;
  const app = await appQ;
  let status: InfluencerApplicationState["status"] = "none";
  let rejectReason: string | null = null;
  if (app?.status === "submitted") status = "submitted";
  else if (app?.status === "approved") status = "approved";
  else if (app?.status === "rejected") {
    status = "rejected";
    let codes: string[] = [];
    try { const v = JSON.parse(app.reject_reasons_json ?? "[]"); if (Array.isArray(v)) codes = v.filter((x): x is string => typeof x === "string"); } catch { /* none */ }
    const parts = codes.map((c) => REJECT_REASONS[c] ?? c);
    if (app.reject_note?.trim()) parts.push(app.reject_note.trim());
    rejectReason = parts.join(" ") || null;
  } else if (hostStatus) status = "draft";
  if (isInfluencer(hostStatus)) return { status: status === "none" || status === "draft" ? "approved" : status, rejectReason: null, missing: [] };
  let cats: string[] = [];
  try { const v = JSON.parse(app?.categories_json ?? "[]"); if (Array.isArray(v)) cats = v.map((x) => (typeof x === "string" ? x : (x as { id?: string })?.id ?? "")).filter(Boolean); } catch { /* none */ }
  const missing = await applicationMissing(env, uid, { categories: cats });
  return { status, rejectReason, missing };
}
