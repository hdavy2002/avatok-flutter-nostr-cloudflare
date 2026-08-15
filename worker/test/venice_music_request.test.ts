import { afterEach, describe, expect, it, vi } from "vitest";
import { veniceQueueMusic } from "../src/lib/venice";

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
      "ace-step-15",
      "Upbeat electronic dance track with a warm vocal",
      { durationSeconds: 60, lyricsPrompt: "We dance until the morning light" },
    );

    expect(JSON.parse(String(requestBody))).toEqual({
      model: "ace-step-15",
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
      "minimax-music-v25",
      "Instrumental piano and strings",
      { durationSeconds: 120 },
    );

    expect(JSON.parse(String(requestBody))).toEqual({
      model: "minimax-music-v25",
      prompt: "Instrumental piano and strings",
    });
  });
});
