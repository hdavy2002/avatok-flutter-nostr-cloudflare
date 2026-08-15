import { describe, expect, it } from "vitest";
import {
  clampSongDurationSeconds,
  isSongApproval,
  isSongRevisionIntent,
  hasSongProductionContext,
  hasInstrumentalProductionContext,
  classifySongRequest,
  nextSongFlow,
  parseSongDurationSeconds,
  stripAvaWakeWordForIntent,
  withSongLyrics,
} from "../src/lib/song_flow";

describe("deterministic song flow", () => {
  it("classifies music once and keeps instrumental requests lyric-free", () => {
    expect(classifySongRequest("make a reggae song for me")).toBe("vocal");
    expect(classifySongRequest("make an instrumental reggae beat")).toBe("instrumental");
    expect(hasInstrumentalProductionContext("reggae instrumental, upbeat, bass, drums, guitar")).toBe(true);
    const asked = nextSongFlow(null, "make an instrumental reggae beat");
    expect(asked).toMatchObject({ kind: "ask_brief", flow: { kind: "instrumental" } });
    if (asked.kind !== "ask_brief") throw new Error("expected ask_brief");
    expect(nextSongFlow(asked.flow, "reggae, upbeat, bass and drums for a travel reel")).toMatchObject({
      kind: "generate", flow: { kind: "instrumental", phase: "generating" },
    });
  });
  it("requires the complete production context before drafting", () => {
    const asked = nextSongFlow(null, "create a reggae song for me");
    expect(asked).toMatchObject({ kind: "ask_brief", flow: { phase: "awaiting_brief" } });
    if (asked.kind !== "ask_brief") throw new Error("expected ask_brief");
    const stillAsking = nextSongFlow(asked.flow, "reggae, English, female voice");
    expect(stillAsking).toMatchObject({ kind: "draft", flow: { phase: "awaiting_brief" } });
    expect(hasSongProductionContext("reggae, English, female voice")).toBe(true);
    expect(hasSongProductionContext("reggae, English")).toBe(false);
  });
  it("strips only a leading Ava marker for intent", () => {
    expect(stripAvaWakeWordForIntent("@ava make me a song")).toBe("make me a song");
    expect(stripAvaWakeWordForIntent("#ava make me a song")).toBe("make me a song");
    expect(stripAvaWakeWordForIntent("@ava private: make me a song")).toBe("make me a song");
    expect(stripAvaWakeWordForIntent("@ava! make me a song")).toBe("make me a song");
    expect(stripAvaWakeWordForIntent("please ask @ava to make a song")).toBe("please ask @ava to make a song");
  });

  it("parses offered duration choices and clamps explicit durations", () => {
    expect(parseSongDurationSeconds("sad indie, 1 minute")).toBe(60);
    expect(parseSongDurationSeconds("1.5 minutes please")).toBe(90);
    expect(parseSongDurationSeconds("make it 2 min")).toBe(120);
    expect(parseSongDurationSeconds("3 minutes")).toBe(180);
    expect(parseSongDurationSeconds("500 seconds")).toBe(210);
    expect(clampSongDurationSeconds(10)).toBe(60);
  });

  it("keeps approval strict and identifies revision requests", () => {
    expect(isSongApproval("yes, make it")).toBe(true);
    expect(isSongApproval("I think yes, make it eventually")).toBe(false);
    expect(isSongRevisionIntent("make the chorus sadder")).toBe(true);
    expect(isSongRevisionIntent("this reminds me of a song")).toBe(false);
  });

  it("transitions bare request, brief, review, revision, and approval deterministically", () => {
    const asked = nextSongFlow(null, "@ava make me a song");
    expect(asked).toMatchObject({ kind: "ask_brief", flow: { phase: "awaiting_brief" } });
    if (asked.kind !== "ask_brief") throw new Error("expected ask_brief");

    const draft = nextSongFlow(asked.flow, "A hopeful indie song about coming home, English, female voice, 2 minutes");
    expect(draft).toMatchObject({ kind: "draft", flow: { brief: expect.stringContaining("coming home"), durationSeconds: 120 } });
    if (draft.kind !== "draft") throw new Error("expected draft");

    const detailedAsk = nextSongFlow(null, "@ava make a 90 second pop song about home");
    expect(detailedAsk).toMatchObject({ kind: "ask_brief", flow: { brief: expect.stringContaining("pop song"), durationSeconds: 90 } });
    if (detailedAsk.kind !== "ask_brief") throw new Error("expected detailed ask");
    const detailed = nextSongFlow(detailedAsk.flow, "English, female voice, bright and soulful");
    expect(detailed).toMatchObject({ kind: "draft", flow: { brief: expect.stringContaining("pop song"), durationSeconds: 90 } });
    if (detailed.kind !== "draft") throw new Error("expected detailed draft");

    const reviewing = withSongLyrics(draft.flow, "Verse one\n...\nChorus");
    const revision = nextSongFlow(reviewing, "make the chorus sadder");
    expect(revision).toMatchObject({ kind: "draft", flow: { phase: "awaiting_brief", durationSeconds: 120 } });

    const approved = nextSongFlow(reviewing, "yes, make it");
    expect(approved).toMatchObject({ kind: "generate", flow: { phase: "generating", lyrics: "Verse one\n...\nChorus" } });

    const restarted = nextSongFlow({ ...reviewing, phase: "completed" }, "make another song");
    expect(restarted).toMatchObject({ kind: "ask_brief", flow: { phase: "awaiting_brief" } });
  });
});
