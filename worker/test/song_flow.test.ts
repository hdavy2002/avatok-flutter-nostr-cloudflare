import { describe, expect, it } from "vitest";
import {
  clampSongDurationSeconds,
  classifySongRequest,
  isSongProductionContextReady,
  nextSongFlow,
  parseSongDurationSeconds,
  songProductionBrief,
  stripAvaWakeWordForIntent,
  withSongInterview,
  withSongLyrics,
  type SongProductionContext,
} from "../src/lib/song_flow";

const completeVocal: SongProductionContext = {
  theme: "Gen Z finding confidence and community",
  genre: "funky island reggae",
  mood: "happy, youthful and uplifting",
  instruments: ["heavy electric bass", "skank guitar", "one-drop drums", "warm organ"],
  language: "English",
  vocalArrangement: "male and female duet",
  voiceStyle: "youthful, bright and soulful",
  durationSeconds: 120,
};

describe("AI-led song flow guardrails", () => {
  it("classifies vocal and instrumental creation without writing the conversation", () => {
    expect(classifySongRequest("make a reggae song for me")).toBe("vocal");
    expect(classifySongRequest("make an instrumental reggae beat")).toBe("instrumental");
    expect(classifySongRequest("I listened to a reggae song")).toBeNull();
  });

  it("persists free-form turns for AI instead of keyword-matching answers", () => {
    const asked = nextSongFlow(null, "make a reggae song about Gen Z");
    expect(asked).toMatchObject({ kind: "ask_brief", flow: { kind: "vocal", phase: "awaiting_brief" } });
    if (asked.kind !== "ask_brief") throw new Error("expected ask_brief");
    const continued = nextSongFlow(asked.flow, "you know, something sunny but not cheesy; you pick the band");
    expect(continued).toMatchObject({ kind: "ask_brief", flow: { phase: "awaiting_brief" } });
    if (continued.kind !== "ask_brief") throw new Error("expected ask_brief");
    expect(continued.flow.conversation).toContain("something sunny but not cheesy");
  });

  it("lets server validation—not model prose—decide when the vocal brief is ready", () => {
    expect(isSongProductionContextReady(completeVocal, "vocal")).toBe(true);
    expect(isSongProductionContextReady({ ...completeVocal, instruments: [] }, "vocal")).toBe(true);
    expect(isSongProductionContextReady({ ...completeVocal, vocalArrangement: undefined, voiceStyle: undefined }, "vocal")).toBe(true);
    expect(isSongProductionContextReady({ ...completeVocal, mood: undefined }, "vocal")).toBe(false);
    expect(isSongProductionContextReady({ ...completeVocal, language: undefined }, "instrumental")).toBe(true);
  });

  it("sends every active conversation turn back to AI instead of matching command words", () => {
    const hindiRock = {
      ...completeVocal,
      theme: "freedom and change", genre: "Hindi rock", mood: "uplifting and energetic",
      language: "Hindi", durationSeconds: 180,
      instruments: undefined, vocalArrangement: undefined, voiceStyle: undefined,
    };
    const waiting = {
      phase: "awaiting_brief" as const, kind: "vocal" as const,
      context: hindiRock,
      conversation: "A three-minute uplifting Hindi rock anthem about freedom",
      durationSeconds: 180,
    };
    expect(nextSongFlow(waiting, "go ahead and draft")).toMatchObject({
      kind: "ask_brief", flow: { phase: "awaiting_brief", conversation: expect.stringContaining("go ahead and draft") },
    });
    expect(nextSongFlow(waiting, "I trust where you're taking this")).toMatchObject({
      kind: "ask_brief", flow: { phase: "awaiting_brief", conversation: expect.stringContaining("I trust where") },
    });
  });

  it("stores AI-extracted choices and assembles the actual model brief", () => {
    const asked = nextSongFlow(null, "make a reggae song about Gen Z");
    if (asked.kind !== "ask_brief") throw new Error("expected ask_brief");
    const interviewed = withSongInterview(asked.flow, completeVocal, "That direction has real lift. I have enough to write it.");
    expect(interviewed.durationSeconds).toBe(120);
    expect(interviewed.context).toEqual(completeVocal);
    expect(interviewed.brief).toContain("funky island reggae");
    expect(interviewed.brief).toContain("heavy electric bass");
    expect(songProductionBrief(completeVocal, "vocal")).toContain("male and female duet");
  });

  it("lets AI interpret approvals, revisions, and new directions during lyric review", () => {
    const reviewing = withSongLyrics({
      phase: "awaiting_brief", kind: "vocal", context: completeVocal,
      conversation: "make a reggae song about Gen Z", brief: songProductionBrief(completeVocal, "vocal"),
      durationSeconds: 120,
    }, "[Verse]\nA new day\n[Chorus]\nWe rise");
    expect(nextSongFlow(reviewing, "these lyrics feel like us—let's hear the song")).toMatchObject({
      kind: "ask_brief", flow: { phase: "reviewing", context: completeVocal },
    });
    expect(nextSongFlow(reviewing, "make the chorus more playful")).toMatchObject({
      kind: "ask_brief", flow: { phase: "reviewing", context: completeVocal },
    });
    expect(nextSongFlow(reviewing, "make another song about Anguilla")).toMatchObject({
      kind: "ask_brief", flow: { phase: "reviewing", conversation: expect.stringContaining("Anguilla") },
    });
  });

  it("still normalizes wake words and duration bounds", () => {
    expect(stripAvaWakeWordForIntent("@ava private: make me a song")).toBe("make me a song");
    expect(parseSongDurationSeconds("1.5 minutes please")).toBe(90);
    expect(parseSongDurationSeconds("500 seconds")).toBe(210);
    expect(clampSongDurationSeconds(10)).toBe(60);
  });
});
