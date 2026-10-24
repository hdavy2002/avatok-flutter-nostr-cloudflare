import type { Env } from "../types";
import { getHost, listMedia } from "./hf_host_store";
import { isCreatorCategory, validCreatorRate } from "./hf_creator_pricing";
import { identityEvidenceBlockers, isPhoneVerified } from "./hf_public_verification";
import { INTRO_MIN_SECONDS } from "./hf_intro";
import { isCreatorFixture } from "./hf_creator_fixtures";
import { spaceQualified } from "./hf_spaces";

/** [HF-IDV-WHATSAPP-1 2026-10-24] Identity = a WhatsApp-OTP-verified number. No Aadhaar, no selfie video.
 *  Payout details are NOT a go-live blocker any more: payouts keep their own Aadhaar check (owner decision) and are set up when the creator withdraws. */
export async function creatorPublicationBlockers(env: Env, uid: string): Promise<string[]> {
  if (isCreatorFixture(uid)) return ["sample_data"];
  const h = await getHost(env, uid);
  if (!h) return ["listing_missing"];
  // [HF-CREATOR-SPACES-1] A Women-only / LGBTQ+ space creator is published only after her video KYC qualifies her.
  const spaceBlock = (await spaceQualified(env, uid)) ? [] : ["video_kyc_required"];
  if (!isCreatorCategory(h.category)) return spaceBlock;
  const [phoneOk, media] = await Promise.all([isPhoneVerified(env, uid), listMedia(env, uid)]);
  const missing = [...identityEvidenceBlockers({ phone_verified: phoneOk ? 1 : 0 }), ...spaceBlock];
  if (!h.display_name?.trim() || !h.about?.trim() || !h.tagline?.trim()) missing.push("profile");
  if (!validCreatorRate(h.price_per_min)) missing.push("price");
  if (!h.agreements_at) missing.push("agreements");
  if (!h.voice_sample_r2 || (h.voice_seconds ?? 0) < INTRO_MIN_SECONDS || h.intro_status !== "approved" || !media.some(m => m.kind === "intro_audio")) missing.push("voice");
  if (!media.some(m => m.kind === "profile")) missing.push("profile_media");
  return missing;
}
