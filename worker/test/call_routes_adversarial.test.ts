import { describe, expect, it } from "vitest";
import {
  deriveCallRecipient,
  deriveQuickReplyRecipient,
  QUICK_REPLY_CATALOG_V1,
} from "../src/lib/call_route_authority";

const participants = { callerUid: "caller", calleeUid: "callee" };

describe("Wave 0 call-route authority", () => {
  it("derives status recipients from persisted membership", () => {
    expect(deriveCallRecipient(participants, "caller")).toBe("callee");
    expect(deriveCallRecipient(participants, "callee")).toBe("caller");
  });

  it("fails closed for a forged recipient and a non-member", () => {
    expect(deriveCallRecipient(participants, "caller")).not.toBe("attacker");
    expect(deriveCallRecipient(participants, "attacker")).toBeNull();
    expect(deriveCallRecipient(participants, "")).toBeNull();
  });

  it("allows quick replies only from the persisted callee", () => {
    expect(deriveQuickReplyRecipient(participants, "callee")).toBe("caller");
    expect(deriveQuickReplyRecipient(participants, "caller")).toBeNull();
    expect(deriveQuickReplyRecipient(participants, "attacker")).toBeNull();
  });

  it("has no client-authored fallback text", () => {
    expect(QUICK_REPLY_CATALOG_V1.will_call_back).toBe("Will call back");
    expect((QUICK_REPLY_CATALOG_V1 as Record<string, string>).injection).toBeUndefined();
  });
});
