import { describe, expect, it } from "vitest";
import { parseVideoInterviewTurn, VIDEO_INTERVIEW_SYSTEM, videoInterviewPayload } from "../src/lib/video_interview";
import { isVideoContextReady, nextVideoFlow } from "../src/lib/video_flow";
import type { MediaModelChoice } from "../src/lib/media_model_catalog";

const models: MediaModelChoice[] = [{
  id: "video-one", provider: "Test", media: "video", label: "Video One",
  supports: ["text-to-video"], durationsSeconds: [8, 10, 12, 14],
  resolutions: ["1080p"], aspectRatios: ["9:16", "16:9"],
  price: { kind: "flat", tokens: 45, unit: "per clip" },
}];

describe("AI video producer conversation", () => {
  it("keeps ordinary continuation turns in the active conversation", () => {
    const started = nextVideoFlow(null, "make a reel about starting over")!;
    const continued = nextVideoFlow(started, "you choose what feels hopeful")!;
    expect(continued.conversation).toContain("you choose what feels hopeful");
  });

  it("merges context and validates only catalog model ids", () => {
    const turn = parseVideoInterviewTurn(
      '{"action":"generate","reply":"Great — I’ll make the vertical reel now.","context":{"goal":"hopeful fresh start","aspectRatio":"9:16","durationSeconds":10,"resolution":"1080p","modelId":"video-one","sourceMode":"text"}}',
      { mood: "uplifting" }, models,
    );
    expect(turn.context.mood).toBe("uplifting");
    expect(turn.context.modelId).toBe("video-one");
    expect(isVideoContextReady(turn.context)).toBe(true);
  });

  it("feeds runtime capabilities and forbids questionnaire behavior", () => {
    const payload = JSON.parse(videoInterviewPayload({ phase:"discovering" }, "what can you make?", models));
    expect(payload.availableModels[0].price.tokens).toBe(45);
    expect(VIDEO_INTERVIEW_SYSTEM).toContain("never a questionnaire");
    expect(VIDEO_INTERVIEW_SYSTEM).toContain("Ask at most ONE focused question");
    expect(VIDEO_INTERVIEW_SYSTEM).toContain("Never invent a model");
  });
});
