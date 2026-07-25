// [AI-MEDIA-ROLLOUT-1] Stub handlers must never be advertised as live.
import { describe, expect, it } from "vitest";
import { isAiMediaKindImplemented } from "../src/queues/ai_media";
import type { AiMediaJobKind } from "../src/lib/ai_media_jobs";

describe("AI media per-kind readiness", () => {
  it("keeps all five stubbed kinds dark", () => {
    const kinds: AiMediaJobKind[] = [
      "image_generate",
      "doc_summarize",
      "doc_translate",
      "audio_transcribe",
      "audio_translate",
    ];
    for (const kind of kinds) expect(isAiMediaKindImplemented(kind)).toBe(false);
  });
});
