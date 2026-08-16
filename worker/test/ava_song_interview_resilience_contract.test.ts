import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Ava song interview resilience contract", () => {
  it("uses one structured multi-provider contract for song and video", () => {
    const agent = readFileSync("src/do/ava_agent.ts", "utf8");
    expect(agent).toContain("private async callStructuredMediaInterview<T>");
    expect(agent).toContain("private async callSongInterview(");
    expect(agent).toContain("private async callVideoInterview(");
    expect(agent).toContain('capability: "song_interview"');
    expect(agent).toContain('capability: "video_interview"');
    expect(agent).toContain("maxTokens = 900");
    expect(agent).toContain("json: true");
    expect(agent).toContain('throw new Error("empty_response")');
    expect(agent).toContain('feature: "gemini_direct"');
    expect(agent).toContain("SONG_INTERVIEW_FALLBACK_MODEL");
    expect(agent).toContain("await veniceChatComplete(");
    expect(agent).toContain('"ava_media_interview_attempt"');
  });

  it("never drops an exhausted song interview into the generic tool lane", () => {
    const agent = readFileSync("src/do/ava_agent.ts", "utf8");
    expect(agent).toContain('outcome: "ai_interview_models_exhausted"');
    expect(agent).toContain("turn_id: statusId");
    expect(agent).toContain("text: songInterviewRecoveryReply()");
    expect(agent).toContain('return { ok: false, status_id: statusId, error: "song_interview_models_exhausted" }');
    expect(agent).not.toContain('songAction = { kind: "none", flow: activeInterviewFlow }');
  });

  it("allows the AI to reset stale song context semantically", () => {
    const interview = readFileSync("src/lib/song_interview.ts", "utf8");
    const agent = readFileSync("src/do/ava_agent.ts", "utf8");
    expect(interview).toContain('Choose action "restart"');
    expect(interview).toContain('action === "restart" ? undefined : previous');
    expect(agent).toContain('outcome: "ai_conversation_restarted"');
  });
});
