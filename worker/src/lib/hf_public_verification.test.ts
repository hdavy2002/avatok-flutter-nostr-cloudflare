import { describe, expect, it } from "vitest";
import { identityEvidenceBlockers, publicVerification } from "./hf_public_verification";

const kyc = { verified_at: 1, age_ok: 1 };
const video = { review_status: "approved", r2_key: "private/video", mime: "video/mp4", code: "123456" };
describe("public verification evidence", () => {
  it("requires live listing for call eligibility, independently of presence", () => {
    expect(publicVerification(kyc, video, "live")).toEqual({ identityVerified: true, callEligible: true });
    expect(publicVerification(kyc, video, "approved")).toEqual({ identityVerified: true, callEligible: false });
  });
  it.each([null, {}, { verified_at: 1, age_ok: 0 }, { verified_at: null, age_ok: 1 }])("fails closed for incomplete identity %j", evidence => {
    expect(publicVerification(evidence, video, "live").identityVerified).toBe(false);
  });
  it.each([null, {}, { ...video, review_status: "pending" }, { ...video, review_status: "rejected" },
    { ...video, r2_key: "" }, { ...video, mime: "image/jpeg" }, { ...video, code: "1234" }])("fails closed for invalid video %j", evidence => {
    expect(publicVerification(kyc, evidence, "live")).toEqual({ identityVerified: false, callEligible: false });
  });
  it("retains publication blocker names and order", () => {
    expect(identityEvidenceBlockers(null, null)).toEqual(["identity_verification", "video_kyc"]);
    expect(identityEvidenceBlockers(kyc, video)).toEqual([]);
  });
});
