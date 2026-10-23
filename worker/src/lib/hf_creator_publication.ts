import type { Env } from "../types";
import { getHost, listMedia } from "./hf_host_store";
import { isCreatorCategory, validCreatorRate } from "./hf_creator_pricing";
import { identityEvidenceBlockers } from "./hf_public_verification";
import { INTRO_MIN_SECONDS } from "./hf_intro";
import { isCreatorFixture } from "./hf_creator_fixtures";

/** No inferred verification: requires the actual latest approved video and authoritative identity/payout records. */
export async function creatorPublicationBlockers(env: Env, uid: string): Promise<string[]> {
  if (isCreatorFixture(uid)) return ["sample_data"];
  const h = await getHost(env, uid);
  if (!h) return ["listing_missing"];
  if (!isCreatorCategory(h.category)) return [];
  const [kyc, video, payout, media] = await Promise.all([
    env.DB_META.prepare("SELECT verified_at, age_ok FROM hf_kyc WHERE uid=?1").bind(uid).first<{ verified_at: number | null; age_ok: number }>(),
    env.DB_META.prepare("SELECT review_status, r2_key, mime, code FROM hf_selfie WHERE uid=?1 ORDER BY created_at DESC, id DESC LIMIT 1")
      .bind(uid).first<{ review_status: string; r2_key: string | null; mime: string | null; code: string }>(),
    env.DB_META.prepare("SELECT upi_enc FROM hf_payout WHERE uid=?1").bind(uid).first<{ upi_enc: string | null }>(),
    listMedia(env, uid),
  ]);
  const missing = identityEvidenceBlockers(kyc, video);
  if (!payout?.upi_enc) missing.push("payout"); // [HF-UPI-ONLY-1] a UPI ID on file; no bank account
  if (!h.display_name?.trim() || !h.about?.trim() || !h.tagline?.trim()) missing.push("profile");
  if (!validCreatorRate(h.price_per_min)) missing.push("price");
  if (!h.agreements_at) missing.push("agreements");
  if (!h.voice_sample_r2 || (h.voice_seconds ?? 0) < INTRO_MIN_SECONDS || h.intro_status !== "approved" || !media.some(m => m.kind === "intro_audio")) missing.push("voice");
  if (!media.some(m => m.kind === "profile")) missing.push("profile_media");
  return missing;
}
