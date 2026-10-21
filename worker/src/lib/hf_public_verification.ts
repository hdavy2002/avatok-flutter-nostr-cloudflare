/** Private evidence stays inside the worker. Only the two booleans are public. */
export interface IdentityEvidence {
  verified_at?: number | null;
  age_ok?: number | null;
}
export interface VideoEvidence {
  review_status?: string | null;
  r2_key?: string | null;
  mime?: string | null;
  code?: string | null;
}

/** Shared with creator publication; callers must supply the latest video, never an older approval. */
export function identityEvidenceBlockers(kyc: IdentityEvidence | null | undefined, video: VideoEvidence | null | undefined): string[] {
  const missing: string[] = [];
  if (!kyc?.verified_at || kyc.age_ok !== 1) missing.push("identity_verification");
  if (video?.review_status !== "approved" || !video.r2_key || !video.mime?.startsWith("video/") || !/^\d{6}$/.test(video.code ?? "")) missing.push("video_kyc");
  return missing;
}

export function publicVerification(kyc: IdentityEvidence | null | undefined, video: VideoEvidence | null | undefined, listingStatus: string) {
  const identityVerified = identityEvidenceBlockers(kyc, video).length === 0;
  return { identityVerified, callEligible: identityVerified && listingStatus === "live" };
}
