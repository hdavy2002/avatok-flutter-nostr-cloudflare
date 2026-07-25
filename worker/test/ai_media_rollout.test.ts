// [AI-MEDIA-ROLLOUT-1] A kind must never be advertised as live unless a real
// handler exists for it. Advertising a kind with no handler is worse than a
// compile error: the user is charged and gets nothing back.
//
// [AVA-DOC-ARTIFACT-1]/[AVA-AUDIO-ARTIFACT-1] 2026-07-25: the four doc/audio
// kinds now have real queue handlers, so this test flipped from "all five are
// dark" to asserting the actual contract — which of the five the QUEUE owns.
//
// `image_generate` is deliberately NOT queue-implemented and must stay that
// way: its input is an ephemeral prompt that §41/§42 forbids persisting to the
// job table or a queue message, so a job_id-only redelivery could never safely
// redo it. It is fulfilled inline by its owning route (`routes/ava_image.ts`
// `fulfil()`), which holds the prompt in the same request closure. If someone
// later adds it to IMPLEMENTED_KINDS, this test is the thing that should stop
// them and send them to read Part VI §44 first.
import { describe, expect, it } from "vitest";
import { isAiMediaKindImplemented } from "../src/queues/ai_media";
import type { AiMediaJobKind } from "../src/lib/ai_media_jobs";

describe("AI media per-kind readiness", () => {
  const QUEUE_IMPLEMENTED: AiMediaJobKind[] = [
    "doc_summarize",
    "doc_translate",
    "audio_transcribe",
    "audio_translate",
  ];
  const ROUTE_OWNED: AiMediaJobKind[] = ["image_generate"];

  it("advertises exactly the four kinds the queue has real handlers for", () => {
    for (const kind of QUEUE_IMPLEMENTED) {
      expect(isAiMediaKindImplemented(kind), `${kind} should be queue-live`).toBe(true);
    }
  });

  it("never advertises image_generate as queue-implemented (prompt must not be persisted)", () => {
    for (const kind of ROUTE_OWNED) {
      expect(isAiMediaKindImplemented(kind), `${kind} is route-owned, not queue-owned`).toBe(false);
    }
  });

  it("covers every declared kind, so a newly added kind cannot slip through untested", () => {
    const all = [...QUEUE_IMPLEMENTED, ...ROUTE_OWNED];
    expect(new Set(all).size).toBe(5);
  });
});
