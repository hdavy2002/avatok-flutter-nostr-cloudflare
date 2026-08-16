import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VENICE_VIDEO_DEFAULT_RESOLUTION,
  veniceQueueVideo,
  veniceVideoPreflight,
} from "../src/lib/venice";

describe("Venice video preflight", () => {
  afterEach(() => vi.unstubAllGlobals());

  const env = {
    VENICE_API_KEY: "test-key",
    TOKENS: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    },
  } as any;

  it("accepts catalog entries that expose the model id in model_spec", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      data: [{ model_spec: { model_id: "ltx-2-v2-3-fast-text-to-video" } }],
    }), { headers: { "content-type": "application/json" } }));

    await expect(veniceVideoPreflight(env, "ltx-2-v2-3-fast-text-to-video"))
      .resolves.toEqual({ ok: true, model: "ltx-2-v2-3-fast-text-to-video" });
  });

  it("fails closed when the configured route is absent from the catalog", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      data: [{ id: "some-other-video-model" }],
    }), { headers: { "content-type": "application/json" } }));

    await expect(veniceVideoPreflight(env, "ltx-2-v2-3-fast-text-to-video"))
      .resolves.toEqual({ ok: false, code: "provider_invalid_request" });
  });

  it("uses only provider-supported LTX resolution and duration tiers", async () => {
    let submitted: any = null;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({ queue_id: "queue-1" }), {
        headers: { "content-type": "application/json" },
      });
    });

    await expect(veniceQueueVideo(
      env,
      "ltx-2-v2-3-fast-text-to-video",
      "A cinematic view of India",
      { duration: "15s" },
    )).resolves.toEqual({ queueId: "queue-1" });
    expect(VENICE_VIDEO_DEFAULT_RESOLUTION).toBe("1080p");
    expect(submitted).toMatchObject({
      model: "ltx-2-v2-3-fast-text-to-video",
      duration: "14s",
      resolution: "1080p",
      aspect_ratio: "9:16",
    });
  });
});
