import { afterEach, describe, expect, it, vi } from "vitest";
import { veniceVideoPreflight } from "../src/lib/venice";

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

  it("does not block a known route when the catalog is partial", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      data: [{ id: "some-other-video-model" }],
    }), { headers: { "content-type": "application/json" } }));

    await expect(veniceVideoPreflight(env, "ltx-2-v2-3-fast-text-to-video"))
      .resolves.toEqual({ ok: true, model: "ltx-2-v2-3-fast-text-to-video" });
  });
});
