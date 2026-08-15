import { describe, expect, it } from "vitest";
import {
  BARE_SONG_QUESTION,
  isBareSongRequest,
  looksLikeInstrumentalMusicRequest,
  looksLikeMusicRequest,
  looksLikeSongRequest,
  looksLikeVideoRequest,
  runAgentLoop,
} from "../src/lib/composio";

describe("forced media routing intent", () => {
  it("recognizes unmistakable video creation without treating calls as video", () => {
    expect(looksLikeVideoRequest("make a video of a neon city at night")).toBe(true);
    expect(looksLikeVideoRequest("start a video call with Maya")).toBe(false);
  });

  it("routes bare song-writing requests into the lyrics-first conversation", () => {
    expect(looksLikeMusicRequest("write me a song about finding home")).toBe(true);
    expect(looksLikeMusicRequest("a song about finding home")).toBe(false);
    expect(looksLikeMusicRequest("what song is playing?")).toBe(false);
  });

  it("sends explicit instrumentals to music generation, never the lyric draft", () => {
    expect(looksLikeInstrumentalMusicRequest("make an instrumental beat")).toBe(true);
    expect(looksLikeSongRequest("make an instrumental beat")).toBe(false);
    expect(looksLikeMusicRequest("make music with no vocals")).toBe(true);
    expect(looksLikeSongRequest("make music with no vocals")).toBe(false);
    expect(looksLikeSongRequest("make a song with no vocals")).toBe(false);
    expect(looksLikeInstrumentalMusicRequest("make a song with no vocals")).toBe(true);
    expect(looksLikeInstrumentalMusicRequest("make some music")).toBe(false);
  });

  it("asks for a brief for the exact bare #ava song request before drafting lyrics", async () => {
    let drafted = false;
    expect(isBareSongRequest("#ava make a song for me")).toBe(true);
    expect(isBareSongRequest("make a song about finding home")).toBe(false);

    await expect(runAgentLoop(
      {} as any, "user", "#ava make a song for me", "", async () => [],
      { onDraftLyrics: async () => { drafted = true; return "unused"; } },
    )).resolves.toBe(BARE_SONG_QUESTION);
    expect(drafted).toBe(false);
  });
});
