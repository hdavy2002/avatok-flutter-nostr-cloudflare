import { describe, expect, it } from "vitest";
import {
  computeCallerFundedTick,
  dailyAudioAllowanceRemaining,
  hourlyCallerFundedTokenEstimate,
  MESSENGER_AUDIO_FREE_PARTICIPANT_SECONDS_DEFAULT,
  MESSENGER_PARTICIPANT_COUNT,
  messengerRateFor,
  utcDayKey,
} from "../src/lib/messenger_call_billing";

/**
 * Phase 1 contract tests for Messenger 1:1 billing math.
 *
 * These intentionally replace the old 200-minute monthly rule.  The shared
 * implementation module keeps its pure calculator so this suite can pin the
 * arithmetic without Durable Object, D1, or provider I/O.
 */
describe("Messenger 1:1 billing math", () => {
  it("uses 28,800 participant-seconds for four free wall-clock hours", () => {
    expect(MESSENGER_AUDIO_FREE_PARTICIPANT_SECONDS_DEFAULT).toBe(28_800);
    expect(MESSENGER_PARTICIPANT_COUNT).toBe(2);

    const oneWallMinute = computeCallerFundedTick({
      priorDailyParticipantSeconds: 0,
      priorCentitokenSeconds: 0,
      wallSeconds: 60,
      dailyAudioAllowanceParticipantSeconds: 28_800,
      media: "audio",
      rateCentitokensPerParticipantMinute: 7,
    });
    expect(oneWallMinute.participantSeconds).toBe(120);
    expect(oneWallMinute.freeParticipantSeconds).toBe(120);
    expect(oneWallMinute.paidParticipantSeconds).toBe(0);
  });

  it("charges only the portion crossing the audio allowance boundary", () => {
    const boundary = computeCallerFundedTick({
      priorDailyParticipantSeconds: 28_740,
      priorCentitokenSeconds: 0,
      wallSeconds: 60,
      dailyAudioAllowanceParticipantSeconds: 28_800,
      media: "audio",
      rateCentitokensPerParticipantMinute: 7,
    });
    expect(boundary.freeParticipantSeconds).toBe(60);
    expect(boundary.paidParticipantSeconds).toBe(60);
  });

  it("charges video from its first genuinely connected participant-second", () => {
    const firstSecond = computeCallerFundedTick({
      priorDailyParticipantSeconds: 0,
      priorCentitokenSeconds: 0,
      wallSeconds: 1,
      dailyAudioAllowanceParticipantSeconds: 28_800,
      media: "video",
      rateCentitokensPerParticipantMinute: 7,
    });
    expect(firstSecond.freeParticipantSeconds).toBe(0);
    expect(firstSecond.paidParticipantSeconds).toBe(2);
    expect(firstSecond.tokensToFund).toBe(1);
  });

  it("uses UTC calendar days and never rolls allowance forward", () => {
    const beforeMidnight = Date.parse("2026-08-24T23:59:59.000Z");
    const afterMidnight = Date.parse("2026-08-25T00:00:00.000Z");
    expect(utcDayKey(beforeMidnight)).toBe("2026-08-24");
    expect(utcDayKey(afterMidnight)).toBe("2026-08-25");
    expect(dailyAudioAllowanceRemaining(28_800, 28_800)).toBe(0);
    expect(dailyAudioAllowanceRemaining(0, 28_800)).toBe(28_800);
  });

  it("calculates the two-seat hourly consent estimate", () => {
    expect(hourlyCallerFundedTokenEstimate(100)).toBe(120);
  });

  it("keeps free audio available while disabling zero-priced paid continuation", () => {
    const config = {
      messengerAudioFreeParticipantSecondsDaily: 28_800,
      messengerAudioPaidCentitokensPerParticipantMinute: 0,
      messengerVideoSdCentitokensPerParticipantMinute: 0,
      messengerVideoHdCentitokensPerParticipantMinute: 17,
      messengerVideo2kCentitokensPerParticipantMinute: 0,
      messengerVideo4kCentitokensPerParticipantMinute: 0,
      messengerCallReservationWallSeconds: 300,
      messengerCallLowBalanceWarningWallSeconds: 300,
      messengerCallUsageTickSeconds: 15,
      messengerCallPriceVersion: 4,
    } as const;
    // Audio at zero is still valid while the daily free allowance remains.
    // The calculator rejects the same rate once connected time crosses the
    // allowance boundary; zero must never silently make overage free.
    expect(messengerRateFor(config, "audio", "audio")).toEqual({
      media: "audio",
      qualitySku: "audio",
      rateCentitokensPerParticipantMinute: 0,
    });
    expect(() => computeCallerFundedTick({
      priorDailyParticipantSeconds: 28_800,
      priorCentitokenSeconds: 0,
      wallSeconds: 1,
      dailyAudioAllowanceParticipantSeconds: 28_800,
      media: "audio",
      rateCentitokensPerParticipantMinute: 0,
    })).toThrow(/non-zero rate/i);
    expect(messengerRateFor(config, "video", "sd")).toBeNull();
    expect(messengerRateFor(config, "video", "hd")).toEqual({
      media: "video",
      qualitySku: "video_hd",
      rateCentitokensPerParticipantMinute: 17,
    });
  });

  it("rejects a zero-rate audio tick exactly at the allowance boundary", () => {
    expect(() => computeCallerFundedTick({
      priorDailyParticipantSeconds: 28_740,
      priorCentitokenSeconds: 0,
      wallSeconds: 60,
      dailyAudioAllowanceParticipantSeconds: 28_800,
      media: "audio",
      rateCentitokensPerParticipantMinute: 0,
    })).toThrow(/non-zero rate/i);
  });
});
