import { describe, expect, it } from "vitest";
import {
  clampSongDurationSeconds,
  classifySongRequest,
  isSongApproval,
  isSongProductionContextReady,
  isSongRevisionIntent,
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
    expect(isSongProductionContextReady({ ...completeVocal, instruments: [] }, "vocal")).toBe(false);
    expect(isSongProductionContextReady({ ...completeVocal, voiceStyle: undefined }, "vocal")).toBe(false);
    expect(isSongProductionContextReady({ ...completeVocal, language: undefined }, "instrumental")).toBe(true);
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

  it("keeps approval strict and preserves AI context through lyric revisions", () => {
    const reviewing = withSongLyrics({
      phase: "awaiting_brief", kind: "vocal", context: completeVocal,
      conversation: "make a reggae song about Gen Z", brief: songProductionBrief(completeVocal, "vocal"),
      durationSeconds: 120,
    }, "[Verse]\nA new day\n[Chorus]\nWe rise");
    expect(isSongApproval("yes, make it")).toBe(true);
    expect(isSongApproval("I think yes, make it eventually")).toBe(false);
    expect(isSongRevisionIntent("make the chorus more playful")).toBe(true);
    expect(nextSongFlow(reviewing, "yes, make it")).toMatchObject({ kind: "generate", flow: { phase: "generating" } });
    expect(nextSongFlow(reviewing, "make the chorus more playful")).toMatchObject({
      kind: "draft", flow: { phase: "awaiting_brief", context: completeVocal },
    });
  });

  it("restarts an abandoned draft when a fresh song is requested", () => {
    const reviewing = withSongLyrics({
      phase: "awaiting_brief", kind: "vocal", context: completeVocal,
      brief: songProductionBrief(completeVocal, "vocal"), durationSeconds: 120,
    }, "Old lyrics");
    expect(nextSongFlow(reviewing, "make another song about Anguilla")).toMatchObject({
      kind: "ask_brief", flow: { phase: "awaiting_brief", kind: "vocal", conversation: expect.stringContaining("Anguilla") },
    });
  });

  it("still normalizes wake words and duration bounds", () => {
    expect(stripAvaWakeWordForIntent("@ava private: make me a song")).toBe("make me a song");
    expect(parseSongDurationSeconds("1.5 minutes please")).toBe(90);
    expect(parseSongDurationSeconds("500 seconds")).toBe(210);
    expect(clampSongDurationSeconds(10)).toBe(60);
  });
});
