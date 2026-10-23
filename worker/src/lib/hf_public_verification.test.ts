import { describe, expect, it } from "vitest";
import { identityEvidenceBlockers, publicVerification } from "./hf_public_verification";

// [HF-IDV-WHATSAPP-1] WhatsApp OTP is the only identity evidence for creators.
describe("public verification evidence", () => {
  it("requires live listing for call eligibility, independently of presence", () => {
    expect(publicVerification({ phone_verified: 1 }, "live")).toEqual({ identityVerified: true, callEligible: true });
    expect(publicVerification({ phone_verified: 1 }, "approved")).toEqual({ identityVerified: true, callEligible: false });
  });
  it.each([null, undefined, {}, { phone_verified: 0 }, { phone_verified: null }])("fails closed without a verified WhatsApp number %j", evidence => {
    expect(publicVerification(evidence, "live")).toEqual({ identityVerified: false, callEligible: false });
  });
  it("names the single blocker", () => {
    expect(identityEvidenceBlockers(null)).toEqual(["whatsapp"]);
    expect(identityEvidenceBlockers({ phone_verified: 1 })).toEqual([]);
  });
});
