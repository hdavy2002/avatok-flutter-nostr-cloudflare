import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  computeHumanCallUsage,
  HUMAN_CALL_FREE_PARTICIPANT_SECONDS,
  CENTITOKEN_SECONDS_PER_TOKEN,
} from "../src/lib/human_call_usage_math";

describe("human call participant-minute pool", () => {
  it("shares the 200-minute allowance across audio and video", () => {
    const r = computeHumanCallUsage({
      priorParticipantSeconds: HUMAN_CALL_FREE_PARTICIPANT_SECONDS - 60,
      priorCentitokenSeconds: 0,
      participantSeconds: 120,
      media: "video",
    });
    expect(r.freeSecondsApplied).toBe(60);
    expect(r.overageSeconds).toBe(60);
    expect(r.tokensToFund).toBe(1);
    expect(r.centitokenSecondsRemainder).toBe(CENTITOKEN_SECONDS_PER_TOKEN - 600);
  });

  it("pre-funds the first overage tick and carries unused credit", () => {
    const first = computeHumanCallUsage({
      priorParticipantSeconds: HUMAN_CALL_FREE_PARTICIPANT_SECONDS,
      priorCentitokenSeconds: 0,
      participantSeconds: 15,
      media: "audio",
    });
    expect(first.tokensToFund).toBe(1);
    expect(first.centitokenSecondsRemainder).toBe(CENTITOKEN_SECONDS_PER_TOKEN - 75);

    const next = computeHumanCallUsage({
      priorParticipantSeconds: HUMAN_CALL_FREE_PARTICIPANT_SECONDS + 15,
      priorCentitokenSeconds: first.centitokenSecondsRemainder,
      participantSeconds: 15,
      media: "audio",
    });
    expect(next.tokensToFund).toBe(0);
    expect(next.centitokenSecondsRemainder).toBe(CENTITOKEN_SECONDS_PER_TOKEN - 150);
  });

  it("video consumes twice the audio rate", () => {
    const audio = computeHumanCallUsage({ priorParticipantSeconds: 12_000, priorCentitokenSeconds: 0, participantSeconds: 60, media: "audio" });
    const video = computeHumanCallUsage({ priorParticipantSeconds: 12_000, priorCentitokenSeconds: 0, participantSeconds: 60, media: "video" });
    expect(audio.centitokenSecondsRemainder).toBe(5_700);
    expect(video.centitokenSecondsRemainder).toBe(5_400);
  });

  it("keeps the new billing lane dark and disconnects only the exhausted seat", () => {
    const config = readFileSync("src/routes/config.ts", "utf8");
    const wallet = readFileSync("src/do/wallet.ts", "utf8");
    const group = readFileSync("src/do/group_call_room.ts", "utf8");
    const oneToOne = readFileSync("src/do/call_room.ts", "utf8");
    expect(config).toContain("humanCallParticipantBillingEnabled: false");
    expect(wallet).toContain('op: "call_usage_consume"');
    expect(wallet).toContain("human_call_usage");
    expect(group).toContain('t: "billing_exhausted"');
    expect(oneToOne).toContain('type: "billing_exhausted"');
  });
});
