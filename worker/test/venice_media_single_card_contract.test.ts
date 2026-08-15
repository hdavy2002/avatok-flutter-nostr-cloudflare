import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Venice media single-card envelopes", () => {
  const agent = readFileSync("src/do/ava_agent.ts", "utf8");
  const queue = readFileSync("src/queues/venice_media.ts", "utf8");
  const routes = readFileSync("src/routes/ai_media_jobs.ts", "utf8");
  const venice = readFileSync("src/lib/venice.ts", "utf8");

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
});
