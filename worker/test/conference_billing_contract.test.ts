import { describe, expect, it } from "vitest";
import { conferenceBillingId, conferenceVideoHoldCost } from "../src/lib/call_billing";

describe("conference billing contract", () => {
  it("keeps each sponsor escrow in a distinct append-only order", () => {
    expect(conferenceBillingId("call-1", "sponsor-a")).toBe("call-1:sponsor:sponsor-a");
    expect(conferenceBillingId("call-1", "sponsor-b")).not.toBe(conferenceBillingId("call-1", "sponsor-a"));
  });

  it("charges video by started hour while audio bypasses this tariff path", () => {
    expect(conferenceVideoHoldCost(1, 20)).toBe(20);
    expect(conferenceVideoHoldCost(60, 20)).toBe(20);
    expect(conferenceVideoHoldCost(61, 20)).toBe(40);
  });
});
