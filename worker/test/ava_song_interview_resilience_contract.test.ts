import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Ava song interview resilience contract", () => {
  it("uses an independent AI failover before any recovery response", () => {
    const agent = readFileSync("src/do/ava_agent.ts", "utf8");
    expect(agent).toContain("private async callSongInterview(");
    expect(agent).toContain("SONG_INTERVIEW_FALLBACK_MODEL");
    expect(agent).toContain("await veniceChatComplete(");
    expect(agent).toContain("recoverSongInterviewDiscussion(fallbackText");
    expect(agent).toContain("recoverSongInterviewDiscussion(primaryText");
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
