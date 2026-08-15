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
    expect(venice).toContain('VENICE_VIDEO_DEFAULT_RESOLUTION = "720p"');
    expect(routes).toContain("aiMediaJobVideoShare");
    expect(routes).toContain("cdn-cgi/image/format=avif");
    expect(routes).toContain('cache-control: asset === "thumbnail" ? "public, max-age=31536000, immutable"');
    expect(routes).toContain('Made on <a href="https://avatok.ai">AvaTOK AI</a>');
  });

  it("gates video admission before billing and watches the thumbnail sidecar", () => {
    expect(venice).toContain("veniceVideoPreflight");
    expect(venice).toContain("ltx-2-v2-3-fast-text-to-video");
    expect(venice).toContain("ltx-2-v2-3-fast-image-to-video");
    expect(venice).toContain("VENICE_VIDEO_MAX_SECONDS = 15");
    expect(venice).toContain("same-intent model from the live catalog");
    expect(venice).toContain("VIDEO_CIRCUIT_LIMIT = 3");
    expect(recovery).toContain("listVeniceVideoThumbnailJobsForRecovery");
    expect(recovery).toContain("venice_media_watchdog_scan");
    expect(routes).toContain("videoThumbnailShareable");
  });
});
