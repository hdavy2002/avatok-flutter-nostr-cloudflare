// [VIDEO-AUDIT-1] Locks the VIDEO provider request contract, the same way
// music_provider_contract.test.ts locks the music one. The music lane learned
// its limits from three live Venice 400s in front of real users; the video lane
// has already had one of its own:
//   2026-08-16  resolution: "Invalid enum value. Expected '1080p' | '1440p' |
//               '2160p', received '720p'"   (ltx-2-v2-3-fast-text-to-video)
// A TypeScript union does not exist at runtime, so the guard has to.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  VENICE_VIDEO_ASPECTS,
  VENICE_VIDEO_DEFAULT_ASPECT,
  VENICE_VIDEO_DEFAULT_DURATION,
  VENICE_VIDEO_DEFAULT_RESOLUTION,
  VENICE_VIDEO_DURATIONS_S,
  VENICE_VIDEO_MAX_SECONDS,
  VENICE_VIDEO_MIN_SECONDS,
  VENICE_VIDEO_PROMPT_MAX_CHARS,
  VENICE_VIDEO_RESOLUTIONS,
  capVideoPrompt,
  nearestVideoDuration,
  normalizeVideoAspect,
  normalizeVideoResolution,
} from "../src/lib/venice";
import { mediaModelCatalog } from "../src/lib/media_model_catalog";

describe("video provider request contract", () => {
  it("rejects the exact resolution that failed in production", () => {
    // The literal value from the live 400. It must never reach Venice again.
    expect(normalizeVideoResolution("720p")).toBe(VENICE_VIDEO_DEFAULT_RESOLUTION);
    expect(VENICE_VIDEO_RESOLUTIONS).not.toContain("720p" as any);
  });

  it("keeps every resolution the provider's own enum lists", () => {
    for (const r of ["1080p", "1440p", "2160p"] as const) {
      expect(normalizeVideoResolution(r)).toBe(r);
    }
    expect(VENICE_VIDEO_RESOLUTIONS).toEqual(["1080p", "1440p", "2160p"]);
  });

  it("falls back rather than forwarding junk from parsed JSON", () => {
    for (const junk of [undefined, null, "", "4k", "1080", 1080, {}, "HD"]) {
      expect(normalizeVideoResolution(junk)).toBe(VENICE_VIDEO_DEFAULT_RESOLUTION);
    }
    for (const junk of [undefined, null, "", "4:3", "1:1", "16/9"]) {
      expect(normalizeVideoAspect(junk)).toBe(VENICE_VIDEO_DEFAULT_ASPECT);
    }
    expect(normalizeVideoAspect("16:9")).toBe("16:9");
    expect(normalizeVideoAspect("9:16")).toBe("9:16");
  });

  it("normalizes every product-accepted length onto a real provider tier", () => {
    for (let s = VENICE_VIDEO_MIN_SECONDS; s <= VENICE_VIDEO_MAX_SECONDS; s++) {
      const out = nearestVideoDuration(s);
      expect(out).toMatch(/^\d+s$/);
      expect(VENICE_VIDEO_DURATIONS_S).toContain(Number.parseInt(out, 10) as any);
    }
    expect(nearestVideoDuration(undefined)).toBe(VENICE_VIDEO_DEFAULT_DURATION);
    expect(nearestVideoDuration(0)).toBe(VENICE_VIDEO_DEFAULT_DURATION);
  });

  it("caps an over-long prompt without cutting a word in half", () => {
    const long = `${"A sweeping cinematic drone shot over a rain-soaked city. ".repeat(60)}`;
    expect(long.length).toBeGreaterThan(VENICE_VIDEO_PROMPT_MAX_CHARS);
    const out = capVideoPrompt(long);
    expect(out.length).toBeLessThanOrEqual(VENICE_VIDEO_PROMPT_MAX_CHARS);
    expect(out.length).toBeGreaterThan(0);
    expect(out.endsWith(" ")).toBe(false);
    expect(long.startsWith(out.slice(0, 40))).toBe(true);
  });

  it("leaves a normal crafted prompt byte-identical", () => {
    const normal = "A red kite loops over a wheat field at golden hour, slow push-in, warm haze.";
    expect(capVideoPrompt(normal)).toBe(normal);
  });

  it("never advertises a capability the provider would reject", () => {
    // Catalog honesty: what Ava promises in the interview is what the queue
    // endpoint accepts. A catalog richer than the contract is how a music
    // request became a 400 the user saw.
    const cfg = { veniceVideoTokens: 45, veniceMusicTokens: 10 } as any;
    for (const model of mediaModelCatalog(cfg, "free").video) {
      const durations = model.durationsSeconds as number[];
      expect(Array.isArray(durations)).toBe(true);
      for (const d of durations) {
        expect(VENICE_VIDEO_DURATIONS_S).toContain(d as any);
        expect(d).toBeGreaterThanOrEqual(VENICE_VIDEO_MIN_SECONDS);
        expect(d).toBeLessThanOrEqual(VENICE_VIDEO_MAX_SECONDS);
      }
      for (const r of model.resolutions ?? []) expect(VENICE_VIDEO_RESOLUTIONS).toContain(r as any);
      for (const a of model.aspectRatios ?? []) expect(VENICE_VIDEO_ASPECTS).toContain(a);
    }
  });

  it("shapes the request before sending it and retries a rejection once", () => {
    const wire = readFileSync("src/lib/venice.ts", "utf8");
    // The wire guard is unconditional — a future direct caller cannot bypass it.
    expect(wire).toContain("resolution: normalizeVideoResolution(opts.resolution)");
    expect(wire).toContain("aspect_ratio: normalizeVideoAspect(opts.aspectRatio)");

    const lane = readFileSync("src/lib/venice_media.ts", "utf8");
    expect(lane).toContain("const submitResolution = normalizeVideoResolution(a.resolution)");
    expect(lane).toContain("const submitPrompt = capVideoPrompt(prompt)");
    // A single provider rejection must not dead-end the user (music's
    // [SONG-FALLBACK-1] lesson), but only a request-shape rejection is worth
    // retrying — auth/capacity would fail identically.
    expect(lane).toContain('void track(env, a.uid, "ava_video_submit_fallback"');
    expect(lane).toContain('classifyVeniceError(first) === "provider_invalid_request"');
  });

  it("keeps a failed share thumbnail recoverable and its reason observable", () => {
    const jobs = readFileSync("src/lib/venice_media_jobs.ts", "utf8");
    // Without this a transient thumbnail failure permanently bricked sharing:
    // the share endpoint 409s and /s/video/<token> 404s without cover_media_id.
    expect(jobs).toContain("cover_status='failed' AND completed_at IS NOT NULL");
    expect(jobs).toContain("export async function reopenVideoCover");

    const queue = readFileSync("src/queues/venice_media.ts", "utf8");
    // AWAITED: workerd drops an unawaited send on an early-return path, which
    // is why a real failed cover left no evidence anywhere.
    expect(queue).toContain('await track(env, job.owner_uid, "venice_media_cover_failed"');
  });
});
