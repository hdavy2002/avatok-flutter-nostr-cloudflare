import { describe, expect, it } from "vitest";
import {
  parseSongInterviewTurn,
  recoverSongInterviewDiscussion,
  songInterviewUserPayload,
  SONG_INTERVIEW_SYSTEM,
} from "../src/lib/song_interview";

describe("AI song interview", () => {
  it("merges remembered choices with natural new answers", () => {
    const turn = parseSongInterviewTurn(`\`\`\`json
      {"reply":"Heavy bass will give that happy reggae duet a strong center. Should the voices feel youthful and bright or warmer and soulful?","context":{"theme":"Gen Z confidence","genre":null,"mood":"happy","instruments":["heavy bass"],"language":null,"vocalArrangement":"duet","voiceStyle":null,"durationSeconds":null,"intendedUse":null}}
    \`\`\``, { genre: "reggae", language: "English" });
    expect(turn.reply).toContain("Heavy bass");
    expect(turn.action).toBe("discuss");
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
    expect(payload.currentPhase).toBe("awaiting_brief");
  });

  it("passes the live audio model catalog instead of scripted model claims", () => {
    const model = { id: "audio-one", price: { kind: "flat", tokens: 10, unit: "per track" } };
    const payload = JSON.parse(songInterviewUserPayload({ phase: "awaiting_brief" }, "what can it do?", undefined, [model]));
    expect(payload.availableModels).toEqual([model]);
    expect(SONG_INTERVIEW_SYSTEM).toContain("availableModels as the current source of truth");
  });

  it("forbids checklist-style output in the AI instruction", () => {
    expect(SONG_INTERVIEW_SYSTEM).toContain("Ask at most ONE focused follow-up question");
    expect(SONG_INTERVIEW_SYSTEM).toContain("never a checklist to recite");
    expect(SONG_INTERVIEW_SYSTEM).toContain("Do not repeatedly ask something already answered");
    expect(SONG_INTERVIEW_SYSTEM).toContain("Never decide from a literal keyword");
    expect(SONG_INTERVIEW_SYSTEM).toContain('Choose action "draft"');
    expect(SONG_INTERVIEW_SYSTEM).toContain('Choose action "generate"');
  });

  it("accepts semantic next-step decisions from the model", () => {
    const drafted = parseSongInterviewTurn(
      '{"action":"draft","reply":"I understand the direction. I’ll shape the lyrics around that feeling.","context":{"theme":"freedom and change","genre":"Hindi rock","mood":"uplifting","language":"Hindi","durationSeconds":180}}',
    );
    const generated = parseSongInterviewTurn(
      '{"action":"generate","reply":"That is the emotional center. I’m turning these lyrics into the finished track.","context":{}}',
    );
    expect(drafted.action).toBe("draft");
    expect(generated.action).toBe("generate");
  });

  it("accepts user-supplied lyrics without asking the model to reproduce them", () => {
    const accepted = parseSongInterviewTurn(
      '{"action":"accept_lyrics","reply":"I’ll use your exact words for the song.","context":{"genre":"Hindi rock","mood":"warm","language":"Hindi","durationSeconds":180}}',
    );
    expect(accepted.action).toBe("accept_lyrics");
    expect(SONG_INTERVIEW_SYSTEM).toContain("Never rewrite, summarize, translate, sanitize, or reproduce those lyrics in JSON");
  });

  it("lets the model release a stale song flow when the user changes topic", () => {
    const switched = parseSongInterviewTurn(
      '{"action":"switch","reply":"","context":{}}',
      { genre: "Hindi rock" },
    );
    expect(switched.action).toBe("switch");
    expect(switched.reply).toBe("");
    expect(switched.context.genre).toBe("Hindi rock");
  });

  it("lets AI semantically restart a different song without stale context", () => {
    const restarted = parseSongInterviewTurn(
      '{"action":"restart","reply":"Hindi rock gives freedom a strong lift. Should it feel defiant or hopeful?","context":{"theme":"freedom","genre":"Hindi rock","language":"Hindi","durationSeconds":180}}',
      { theme: "Gen Z beach party", genre: "Caribbean reggae", mood: "funky" },
    );
    expect(restarted.action).toBe("restart");
    expect(restarted.context).toMatchObject({
      theme: "freedom", genre: "Hindi rock", language: "Hindi", durationSeconds: 180,
    });
    expect(restarted.context.mood).toBeUndefined();
  });

  it("keeps a natural AI reply when only its JSON protocol is malformed", () => {
    const recovered = recoverSongInterviewDiscussion(
      "Hindi rock can make freedom feel both personal and anthemic. Should the energy be hopeful or rebellious?",
      { theme: "freedom", genre: "Hindi rock" },
    );
    expect(recovered).toMatchObject({
      action: "discuss",
      context: { theme: "freedom", genre: "Hindi rock" },
    });
    expect(recovered?.reply).toContain("hopeful or rebellious");
    expect(recoverSongInterviewDiscussion('{"broken": true')).toBeNull();
  });
});
