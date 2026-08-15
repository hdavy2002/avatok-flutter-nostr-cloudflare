import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Venice media single-card envelopes", () => {
  const agent = readFileSync("src/do/ava_agent.ts", "utf8");
  const queue = readFileSync("src/queues/venice_media.ts", "utf8");

  it("tags tool-loop acknowledgements with the started media job", () => {
    expect(agent).toContain("let lastStartedMedia:");
    expect(agent).toContain('media_job_kind: "venice_video_generate"');
    expect(agent).toContain('media_job_kind: "venice_music_generate"');
    expect(agent).toContain("...(lastStartedMedia ?? {})");
  });

  it("tags terminal failure fallbacks with the same job id", () => {
    expect(queue).toContain("meta: { job_id: job.job_id, media_job_kind: job.kind }");
  });
});
