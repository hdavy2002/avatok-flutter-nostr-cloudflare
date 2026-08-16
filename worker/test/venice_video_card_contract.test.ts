import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Venice video rich-card contract", () => {
  it("derives specific card metadata and thumbnail art from the crafted scene", () => {
    const prompt = readFileSync("src/lib/media_prompt.ts", "utf8");
    const media = readFileSync("src/lib/venice_media.ts", "utf8");
    const queue = readFileSync("src/queues/venice_media.ts", "utf8");
    expect(prompt).toContain("Study the subject and action, location or culture, lighting, camera language, mood, color, and overall vibe");
    expect(prompt).toContain("Avoid generic phrases such as 'AI video' or 'short video'");
    expect(media).toContain("craftVideoCardMetadata(env, prompt)");
    expect(queue).toContain('Full-frame cinematic thumbnail image for a short video titled');
    expect(queue).toContain("${description}");
  });

  it("serves a player-first page with direct OG media and social sharing", () => {
    const routes = readFileSync("src/routes/ai_media_jobs.ts", "utf8");
    const index = readFileSync("src/index.ts", "utf8");
    expect(routes).toContain('const thumbnail = `${baseUrl}/thumbnail`');
    expect(routes).toContain('property="og:image:secure_url"');
    expect(routes).toContain('property="og:image:alt"');
    expect(routes).toContain('property="og:video"');
    expect(routes).toContain('<video id="shared-video" class="video" controls playsinline');
    expect(routes).toContain('aria-label="Share this video"');
    expect(routes).toContain("wa.me");
    expect(routes).toContain("linkedin.com/sharing");
    expect(routes).toContain('id="close-video"');
    expect(routes).toContain('root.classList.add("video-open")');
    expect(routes).toContain("v.videoHeight>v.videoWidth");
    expect(routes).toContain('if(!v.paused)open()');
    expect(routes).toContain("script-src 'nonce-${nonce}'");
    expect(routes).toContain("?v=${version}");
    expect(routes).toContain("await env.DIGITAL.head(row.key)");
    expect(routes).toContain('"ai_video_share_link_created"');
    expect(routes).not.toContain("cdn-cgi/image/format=avif,quality=60");
    expect(index).toContain('/s\\/video\\/([A-Za-z0-9_-]{10,128})');
    expect(index).toContain('req.method === "GET" || req.method === "HEAD"');
  });

  it("supports browser seeking with byte-range video responses", () => {
    const routes = readFileSync("src/routes/ai_media_jobs.ts", "utf8");
    expect(routes).toContain('headers.set("accept-ranges", "bytes")');
    expect(routes).toContain('status: 206');
    expect(routes).toContain('content-range');
  });
});
