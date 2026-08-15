import { describe, expect, it } from "vitest";
import {
  clampSongDurationSeconds,
  isBareSongRequest,
  isSongCreationRequest,
  isSongApproval,
  isSongRevisionIntent,
  nextSongFlow,
  parseSongDurationSeconds,
  stripAvaWakeWordForIntent,
  withSongLyrics,
} from "../src/lib/song_flow";

describe("deterministic song flow", () => {
  it("strips only a leading Ava marker for intent", () => {
    expect(stripAvaWakeWordForIntent("@ava make me a song")).toBe("make me a song");
    expect(stripAvaWakeWordForIntent("#ava make me a song")).toBe("make me a song");
    expect(stripAvaWakeWordForIntent("@ava private: make me a song")).toBe("make me a song");
    expect(stripAvaWakeWordForIntent("@ava! make me a song")).toBe("make me a song");
    expect(stripAvaWakeWordForIntent("please ask @ava to make a song")).toBe("please ask @ava to make a song");
  });

  it("recognizes only genuinely bare song requests", () => {
    expect(isBareSongRequest("@ava make me a song")).toBe(true);
    expect(isBareSongRequest("#ava write a song for me")).toBe(true);
    expect(isBareSongRequest("@ava make another song")).toBe(true);
    expect(isBareSongRequest("make a song about home")).toBe(false);
    expect(isSongCreationRequest("@ava make a 90-second pop song about home")).toBe(true);
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

    const draft = nextSongFlow(asked.flow, "A hopeful indie song about coming home, 2 minutes");
    expect(draft).toMatchObject({ kind: "draft", flow: { brief: expect.stringContaining("coming home"), durationSeconds: 120 } });
    if (draft.kind !== "draft") throw new Error("expected draft");

    const detailed = nextSongFlow(null, "@ava make a 90 second pop song about home");
    expect(detailed).toMatchObject({ kind: "draft", flow: { brief: expect.stringContaining("pop song"), durationSeconds: 90 } });
    if (detailed.kind !== "draft") throw new Error("expected detailed draft");
    const retried = nextSongFlow(detailed.flow, "try again");
    expect(retried).toMatchObject({ kind: "draft", flow: { brief: detailed.flow.brief, durationSeconds: 90 } });

    const reviewing = withSongLyrics(draft.flow, "Verse one\n...\nChorus");
    const revision = nextSongFlow(reviewing, "make the chorus sadder");
    expect(revision).toMatchObject({ kind: "draft", flow: { phase: "awaiting_brief", durationSeconds: 120 } });

    const approved = nextSongFlow(reviewing, "yes, make it");
    expect(approved).toMatchObject({ kind: "generate", flow: { phase: "generating", lyrics: "Verse one\n...\nChorus" } });

    const restarted = nextSongFlow({ ...reviewing, phase: "completed" }, "make another song");
    expect(restarted).toMatchObject({ kind: "ask_brief", flow: { phase: "awaiting_brief" } });
  });
});
