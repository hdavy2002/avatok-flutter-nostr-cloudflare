import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("media song rich-card contract", () => {
  it("persists safe card metadata, cover state, and fixed tariffs", () => {
    const jobs = readFileSync("src/lib/media_jobs.ts", "utf8");
    const migration = readFileSync("migrations/2026-08-15-venice-song-cards.sql", "utf8");
    expect(jobs).toContain("flat_price_tokens");
    expect(jobs).toContain("song_description");
    expect(jobs).toContain("claimSongCover");
    expect(migration).toContain("cover_media_id");
    expect(migration).toContain("share_token");
    expect(migration).toContain("delivery_status");
  });

  it("keeps the media-job insert aligned with all 27 database columns", () => {
    const jobs = readFileSync("src/lib/media_jobs.ts", "utf8");
    expect(jobs).toContain("NULL,?15,?16,NULL,?17,NULL,0,?18,?19,?19,NULL");
    expect(jobs).not.toContain("?19,?20,?20,NULL");
  });

  it("leases at-least-once delivery and retries settlement before success", () => {
    const jobs = readFileSync("src/lib/media_jobs.ts", "utf8");
    const queue = readFileSync("src/queues/media.ts", "utf8");
    const avaRoute = readFileSync("src/routes/ava_thread.ts", "utf8");
    const avaAgent = readFileSync("src/do/ava_agent.ts", "utf8");
    expect(jobs).toContain("claimMediaDelivery");
    expect(jobs).toContain("status='delivering'");
    expect(jobs).toContain('if (!settled?.ok) return { ok: false');
    expect(jobs).toContain("claimMediaDeliveryNotification");
    expect(queue).toContain('if (job.status === "delivering" && job.artifact_media_id)');
    expect(queue).toContain("if (!(await claimMediaDelivery");
    expect(queue).toContain("await notifyMediaDelivery(env, completed.job");
    expect(queue).toContain('client_id: `media-delivery:${job.job_id}`');
    expect(avaRoute).toContain("client_id: args.client_id");
    expect(avaAgent).toContain("client_id: b.client_id");
    expect(avaAgent).toContain('return { ok: false, error: "inbox_append_failed" }');
  });

  it("generates a separately metered one-Token cover without failing the song", () => {
    const queue = readFileSync("src/queues/media.ts", "utf8");
    // [COVER-RETRY-SAFE-1] The op id is now scoped PER ATTEMPT. A stable id
    // made a watchdog retry unsettleable (wallet reservations are op_id-deduped),
    // so a recovered cover generated, passed its scan, then died with
    // cover_settlement_failed. The claim timestamp keeps one attempt idempotent
    // while letting the next attempt bill cleanly.
    expect(queue).toContain('const opId = `song-cover:${job.job_id}:${attemptStamp}`');
    // [COVER-SCAN-ADVISORY-1] An unobtainable verdict (classifier unreachable)
    // must not cost the artwork — it publishes and is recorded. A genuine
    // BLOCK verdict must STILL discard the image.
    expect(queue).toContain("verdict.ok === false");
    expect(queue).toContain('"media_cover_unscanned_publish"');
    expect(queue).toContain('throw new Error("cover_output_blocked")');
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
    expect(routes).toContain('const cover = job.cover_media_id ? `${canonical}/cover`');
    expect(routes).toContain("Made with AvaTOK app");
    expect(routes).not.toContain("store-badge");
    expect(routes).not.toContain("Made on <strong>AvaTOK App</strong>");
    expect(routes).toContain("wa.me");
    expect(routes).toContain("linkedin.com/sharing");
    expect(routes).toContain('property="og:audio"');
    expect(routes).toContain("<audio controls");
  });
});
