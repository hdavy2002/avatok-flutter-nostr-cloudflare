import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Venice song rich-card contract", () => {
  it("persists safe card metadata, cover state, and fixed tariffs", () => {
    const jobs = readFileSync("src/lib/venice_media_jobs.ts", "utf8");
    const migration = readFileSync("migrations/2026-08-15-venice-song-cards.sql", "utf8");
    expect(jobs).toContain("flat_price_tokens");
    expect(jobs).toContain("song_description");
    expect(jobs).toContain("claimSongCover");
    expect(migration).toContain("cover_media_id");
    expect(migration).toContain("share_token");
    expect(migration).toContain("delivery_status");
  });

  it("leases at-least-once delivery and retries settlement before success", () => {
    const jobs = readFileSync("src/lib/venice_media_jobs.ts", "utf8");
    const queue = readFileSync("src/queues/venice_media.ts", "utf8");
    const avaRoute = readFileSync("src/routes/ava_thread.ts", "utf8");
    const avaAgent = readFileSync("src/do/ava_agent.ts", "utf8");
    expect(jobs).toContain("claimVeniceMediaDelivery");
    expect(jobs).toContain("status='delivering'");
    expect(jobs).toContain('if (!settled?.ok) return { ok: false');
    expect(jobs).toContain("claimVeniceDeliveryNotification");
    expect(queue).toContain('if (job.status === "delivering" && job.artifact_media_id)');
    expect(queue).toContain("if (!(await claimVeniceMediaDelivery");
    expect(queue).toContain("await notifyVeniceMediaDelivery(env, completed.job");
    expect(queue).toContain('client_id: `venice-delivery:${job.job_id}`');
    expect(avaRoute).toContain("client_id: args.client_id");
    expect(avaAgent).toContain("client_id: b.client_id");
    expect(avaAgent).toContain('return { ok: false, error: "inbox_append_failed" }');
  });

  it("generates a separately metered one-Token cover without failing the song", () => {
    const queue = readFileSync("src/queues/venice_media.ts", "utf8");
    expect(queue).toContain('const opId = `song-cover:${job.job_id}`');
    expect(queue).toContain("flatPriceTokens: 1");
    expect(queue).toContain("flatChargeTokens: 1");
    expect(queue).toContain("await generateSongCover(env, job)");
    expect(queue).toContain("await finishSongCover(env, job.job_id, null).catch(() => {})");
  });

  it("publishes only after an authenticated share action and serves OG/player markup", () => {
    const routes = readFileSync("src/routes/ai_media_jobs.ts", "utf8");
    expect(routes).toContain("export async function aiMediaJobSongShare");
    expect(routes).toContain('if (!job.share_token)');
    expect(routes).toContain('property="og:image"');
    expect(routes).toContain("cdn-cgi/image/format=avif,quality=60");
    expect(routes).toContain("MADE ON AVATOK APP");
    expect(routes).toContain("wa.me");
    expect(routes).toContain("linkedin.com/sharing");
    expect(routes).toContain('property="og:audio"');
    expect(routes).toContain("<audio controls");
  });
});
