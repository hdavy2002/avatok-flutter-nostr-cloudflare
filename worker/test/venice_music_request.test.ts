import { afterEach, describe, expect, it, vi } from "vitest";
import { veniceQueueMusic } from "../src/lib/venice";
import { songCardMetadata } from "../src/lib/venice_media";

describe("Venice music queue request", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends musical direction and approved lyrics in their distinct API fields", async () => {
    let requestBody: BodyInit | null | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = init?.body;
      return new Response(JSON.stringify({ queue_id: "music-1" }), {
        headers: { "content-type": "application/json" },
      });
    });

    await veniceQueueMusic(
      { VENICE_API_KEY: "test-key" },
      "minimax-music-v26",
      "Upbeat electronic dance track with a warm vocal",
      { durationSeconds: 60, lyricsPrompt: "We dance until the morning light" },
    );

    expect(JSON.parse(String(requestBody))).toEqual({
      model: "minimax-music-v26",
      prompt: "Upbeat electronic dance track with a warm vocal",
      lyrics_prompt: "We dance until the morning light",
      duration_seconds: 60,
    });
  });

  it("keeps instrumental requests lyric-free and preserves model duration rules", async () => {
    let requestBody: BodyInit | null | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = init?.body;
      return new Response(JSON.stringify({ queue_id: "music-2" }), {
        headers: { "content-type": "application/json" },
      });
    });

    await veniceQueueMusic(
      { VENICE_API_KEY: "test-key" },
      "minimax-music-v26",
      "Instrumental piano and strings",
      { durationSeconds: 120 },
    );

    expect(JSON.parse(String(requestBody))).toEqual({
      model: "minimax-music-v26",
      duration_seconds: 120,
      prompt: "Instrumental piano and strings",
    });
  });
});

describe("song card metadata", () => {
  it("creates bounded share copy without persisting lyrics", () => {
    const card = songCardMetadata("Create me a song about finding home after a long journey", 120, true);
    expect(card.title).toBe("Finding home after a long journey");
    expect(card.description).toContain("2-minute song about");
    expect(card.title.length).toBeLessThanOrEqual(80);
    expect(card.description.length).toBeLessThanOrEqual(160);
    expect(card.description.toLowerCase()).not.toContain("lyrics");
  });
});
