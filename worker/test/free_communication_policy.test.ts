import { describe, expect, it } from "vitest";
import { enforcePermanentFreeCommunication, type PlatformConfig } from "../src/routes/config";
import { enforcePermanentFreeConference, PLANS } from "../src/routes/plans";

describe("permanent free human communication policy", () => {
  it("cannot be reversed by stale platform_config overrides", () => {
    const stale = {
      paidCalls: true,
      conferenceBillingEnabled: true,
      conferenceVideoTokensPerHour: 999,
    } as unknown as PlatformConfig;

    const effective = enforcePermanentFreeCommunication(stale);
    expect(effective.paidCalls).toBe(false);
    expect(effective.conferenceBillingEnabled).toBe(false);
    expect(effective.conferenceVideoTokensPerHour).toBe(0);
  });

  it("gives every subscription tier unlimited 25-person human conferences", () => {
    for (const plan of Object.values(PLANS)) {
      // The legacy Ava-chat plan dimension also remains unlimited; ordinary
      // human messaging is not a metered dimension at all.
      expect(plan.caps.ava_chat).toBeNull();
      expect(plan.caps.conf_min).toBeNull();
      expect(plan.confParticipants).toBe(25);
    }
  });

  it("cannot be reversed by a stale plan_config override", () => {
    const stale = {
      ...PLANS[0],
      confParticipants: 2,
      caps: { ...PLANS[0].caps, conf_min: 1 },
    };
    const effective = enforcePermanentFreeConference(stale);
    expect(effective.caps.conf_min).toBeNull();
    expect(effective.confParticipants).toBe(25);
  });
});
