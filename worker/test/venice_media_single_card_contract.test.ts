import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Venice media single-card envelopes", () => {
  const agent = readFileSync("src/do/ava_agent.ts", "utf8");
  const queue = readFileSync("src/queues/venice_media.ts", "utf8");
  const routes = readFileSync("src/routes/ai_media_jobs.ts", "utf8");
  const venice = readFileSync("src/lib/venice.ts", "utf8");
  const recovery = readFileSync("src/queues/ai_media_recovery.ts", "utf8");

  it("tags tool-loop acknowledgements with the started media job", () => {
    expect(agent).toContain("let lastStartedMedia:");
    expect(agent).toContain('media_job_kind: "venice_video_generate"');
    expect(agent).toContain('media_job_kind: "venice_music_generate"');
    expect(agent).toContain("...(lastStartedMedia ?? {})");
  });

  it("tags terminal failure fallbacks with the same job id", () => {
    expect(queue).toContain("meta: { job_id: job.job_id, media_job_kind: job.kind }");
  });

  it("keeps provider failures classified and video sharing OG-complete", () => {
    expect(venice).toContain("classifyVeniceError");
    expect(venice).toContain('VENICE_VIDEO_DEFAULT_RESOLUTION = "1080p"');
    expect(routes).toContain("aiMediaJobVideoShare");
    // [SHARE-OG-IMAGE-1 2026-08-17] og:image must be a DIRECT asset URL, not a
    // /cdn-cgi/image/... transform wrapped around a Worker route: crawlers do
    // not reliably execute those, and the song card shipped with no preview
    // image for exactly that reason. The size problem the wrapper solved is
    // now handled inside the asset route (200 + resized JPEG, never a 206).
    // This assertion previously required the abandoned wrapper and had been
    // failing since [VENICE-VIDEO-CARD-1] removed it.
    expect(routes).not.toContain("cdn-cgi/image/format=avif");
    expect(routes).toContain('og:image');
    // Assert the INTENT (immutable long cache for the thumbnail, short for the
    // video) rather than one exact source formatting — the previous literal
    // silently went stale when the object key was quoted during a refactor.
    expect(routes).toMatch(/asset === "thumbnail" \? "public, max-age=31536000, immutable" : "public, max-age=300"/);
    // Attribution must link back to avatok.ai from the public share pages.
    // Asserted by intent — the exact wording has been reworded twice and the
    // old literal ("Made on … AvaTOK AI") had gone stale.
    expect(routes).toMatch(/href="https:\/\/avatok\.ai"/);
    expect(routes).toMatch(/AvaTOK/);
  });

  it("gates video admission before billing and watches the thumbnail sidecar", () => {
    expect(venice).toContain("veniceVideoPreflight");
    expect(venice).toContain("ltx-2-v2-3-fast-text-to-video");
    expect(venice).toContain("ltx-2-v2-3-fast-image-to-video");
    expect(venice).toContain("VENICE_VIDEO_MAX_SECONDS = 15");
    expect(venice).toContain("Never substitute an arbitrary same-intent model");
    expect(venice).toContain("VIDEO_CIRCUIT_LIMIT = 3");
    expect(recovery).toContain("listVeniceVideoThumbnailJobsForRecovery");
    expect(recovery).toContain("venice_media_watchdog_scan");
    expect(routes).toContain("videoThumbnailShareable");
  });
});
