import { describe, expect, it } from "vitest";
import {
  parseSongInterviewTurn,
  recoverSongInterviewTurn,
  songInterviewUserPayload,
  SONG_INTERVIEW_SYSTEM,
} from "../src/lib/song_interview";

describe("AI song interview", () => {
  it("merges remembered choices with natural new answers", () => {
    const turn = parseSongInterviewTurn(`\`\`\`json
      {"reply":"Heavy bass will give that happy reggae duet a strong center. Should the voices feel youthful and bright or warmer and soulful?","context":{"theme":"Gen Z confidence","genre":null,"mood":"happy","instruments":["heavy bass"],"language":null,"vocalArrangement":"duet","voiceStyle":null,"durationSeconds":null,"intendedUse":null}}
    \`\`\``, { genre: "reggae", language: "English" });
    expect(turn.reply).toContain("Heavy bass");
    expect(turn.context).toMatchObject({
      theme: "Gen Z confidence", genre: "reggae", mood: "happy",
      instruments: ["heavy bass"], language: "English", vocalArrangement: "duet",
    });
  });

  it("passes previous AI context so shorthand answers remain understandable", () => {
    const payload = JSON.parse(songInterviewUserPayload({
      phase: "awaiting_brief", kind: "vocal",
      conversation: "make a reggae song about Gen Z\n\nyou choose",
      context: { genre: "reggae", theme: "Gen Z" },
      lastInterviewReply: "Would you like bass and skank guitar, or should I choose?",
    }, "you choose"));
    expect(payload.previousAvaReply).toContain("should I choose");
    expect(payload.latestUserMessage).toBe("you choose");
    expect(payload.savedContext.genre).toBe("reggae");
  });

  it("forbids checklist-style output in the AI instruction", () => {
    expect(SONG_INTERVIEW_SYSTEM).toContain("Ask at most ONE focused follow-up question");
    expect(SONG_INTERVIEW_SYSTEM).toContain("never a checklist to recite");
    expect(SONG_INTERVIEW_SYSTEM).toContain("Do not repeatedly ask something already answered");
  });

  it("recovers a useful next question when the provider response cannot be parsed", () => {
    const recovered = recoverSongInterviewTurn({
      phase: "awaiting_brief", kind: "vocal",
      conversation: "create a 3 min hindi rock song",
    }, "uplifting, freedom and change");
    expect(recovered.context).toMatchObject({
      genre: "Hindi rock", language: "Hindi", durationSeconds: 180,
      instruments: ["electric guitar", "bass", "live drums"],
    });
    expect(recovered.reply).toContain("solo male voice");
    expect(recovered.reply).not.toContain("Tell me again");
  });
});
