// [AVA-JOB-PRESENCE-1] Regression contract for the production incident where
// Ava said "Starting production" and then every working indicator disappeared.
// These assertions intentionally cross the Worker/client seam: a server-only
// fix can still leave a blank phone, and a client-only spinner can still lie
// when no durable job exists.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("Ava durable media-job presence handoff", () => {
  const media = readFileSync("src/lib/vertex_media.ts", "utf8");
  const agent = readFileSync("src/do/ava_agent.ts", "utf8");
  const repository = readFileSync("../app/lib/core/ai_media_jobs.dart", "utf8");
  const chatMedia = readFileSync("../app/lib/features/avatok/chat_thread/media.dart", "utf8");
  const chatSend = readFileSync("../app/lib/features/avatok/chat_thread/send.dart", "utf8");

  it("creates a durable song job before posting the production envelope", () => {
    const created = media.indexOf("const created = await createMediaJob");
    const envelope = media.indexOf("client_id: `media-start:${created.job.job_id}`");
    const provider = media.indexOf("await vertexInteraction", envelope);
    expect(created).toBeGreaterThan(-1);
    expect(envelope).toBeGreaterThan(created);
    expect(provider).toBeGreaterThan(envelope);
    expect(media.match(/media-start:\$\{created\.job\.job_id\}/g)).toHaveLength(1);
    expect(media).toContain('reason: "job_start_envelope_failed"');
    expect(media.indexOf('reason: "job_start_envelope_failed"')).toBeLessThan(provider);
  });

  it("does not let model-written copy claim generation before job creation", () => {
    expect(agent).toContain('"Preparing your song production now…"');
    expect(agent).toContain('const conversationalReply = interview.action === "generate" || interview.action === "quick_generate"');
    expect(agent).toContain("text: conversationalReply");
  });

  it("seeds a repository-backed card before the authoritative network fetch", () => {
    expect(repository).toContain("AiMediaJob seedPendingFromEnvelope");
    expect(repository).toContain("_rearmPolling(convId)");
    const seed = chatMedia.indexOf("seedPendingFromEnvelope(");
    const card = chatMedia.indexOf("_upsertJobMessage(provisional)", seed);
    const fetch = chatMedia.indexOf("AiMediaJobRepository.I.fetch(jobId)", seed);
    expect(seed).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(seed);
    expect(fetch).toBeGreaterThan(card);
  });

  it("deduplicates repeated envelopes and persists the card for reopen", () => {
    expect(repository).toContain("final existing = _byId[jobId]");
    expect(repository).toContain("if (existing != null)");
    expect(repository).toContain("unawaited(_persist(convId))");
    expect(repository).toContain("await hydrate(convId)");
    expect(repository).toContain("await reconcile(convId)");
  });

  it("keeps the turn indicator until the durable card is present", () => {
    expect(chatSend).toContain("trigger: 'wire_job_handoff'");
    expect(chatSend).toContain("A job envelope is a handoff, not a terminal reply");
    const card = chatMedia.indexOf("_upsertJobMessage(provisional)");
    const clear = chatMedia.indexOf("_clearAvaWorking('job_card')", card);
    expect(clear).toBeGreaterThan(card);
    expect(chatMedia).toContain("provisional card + polling stay live");
    expect(chatMedia).toContain("'creative_job_card_seen'");
  });
});
