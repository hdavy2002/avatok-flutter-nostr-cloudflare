// [DEL-VOICEMAIL-R2-1] Account deletion must erase voicemail/receptionist audio.
//
// Two things are pinned here:
//   1. the PURE prefix builder (blast-radius guard + the exact prefixes), and
//   2. the fact that the workflow actually sweeps BOTH R2 buckets.
//
// (2) is asserted against the SOURCE TEXT rather than by running the workflow:
// DeletionWorkflow extends WorkflowEntrypoint from `cloudflare:workers`, which
// has no vitest-resolvable module, and the step body is unreachable without a
// real Workflow runtime. Same readFileSync idiom as
// test/native_decline_contract.test.ts. It is deliberately narrow — it exists so
// that dropping the legacy-bucket sweep (which would silently resurrect the bug
// for every pre-2026-08-07 recording) fails a test instead of shipping.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { voicemailR2Prefixes } from "../src/lib/deletion_prefixes";

const SRC = readFileSync(new URL("../src/workflows/deletion.ts", import.meta.url), "utf8");
const STEP = SRC.slice(SRC.indexOf('step.do("r2_voicemail"'), SRC.indexOf("// ---- 8. DB_MODERATION"));
/** Same step with comments stripped — assertions about CODE must not match prose. */
const STEP_CODE = STEP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("voicemail R2 prefixes", () => {
  it("covers both producer prefixes, anchored to the uid being deleted", () => {
    expect(voicemailR2Prefixes("user_2abcDEF")).toEqual([
      "receptionist/user_2abcDEF/",
      "voicemail/user_2abcDEF/",
    ]);
  });

  it("accepts every real uid shape", () => {
    for (const uid of ["user_2abcDEF", "npub1qqqqqqqqqqqqqqq", "guest:0a1b2c3d-4e5f-6789-abcd-ef0123456789"]) {
      expect(voicemailR2Prefixes(uid)).toHaveLength(2);
    }
  });

  it("every prefix ends in a slash so it cannot match a sibling uid", () => {
    // Without the trailing slash, `voicemail/user_2ab` would also match
    // `voicemail/user_2abcDEF/...` — another live account's recordings.
    for (const p of voicemailR2Prefixes("user_2ab")) {
      expect(p.endsWith("/")).toBe(true);
      expect(p.endsWith("user_2ab/")).toBe(true);
    }
  });

  it("REFUSES an empty or wildcard-ish uid instead of deleting everything", () => {
    // `receptionist/` with no uid is every user on the platform.
    for (const bad of ["", " ", "*", "/", "..", "a", "u/../..", "user_2ab/../other", "user 2ab", "user\n2ab"]) {
      expect(voicemailR2Prefixes(bad)).toEqual([]);
    }
  });

  it("never produces a prefix that escapes the account's own path", () => {
    for (const uid of ["user_2abcDEF", "npub1qqq", "guest:0a1b-2c3d"]) {
      for (const p of voicemailR2Prefixes(uid)) {
        expect(p.split("/").filter(Boolean)).toHaveLength(2);
        expect(p).not.toContain("..");
      }
    }
  });
});

describe("DeletionWorkflow r2_voicemail step", () => {
  it("exists", () => {
    expect(STEP.length).toBeGreaterThan(0);
  });

  it("sweeps the private bucket AND the legacy public bucket", () => {
    // env.DIGITAL holds recordings written from [RECEPT-PRIVBUCKET-1] onward;
    // env.BLOBS holds every recording taken before it. Nothing was migrated, so
    // dropping either one leaves a caller's message on disk after erasure.
    expect(STEP_CODE).toContain("env.DIGITAL");
    expect(STEP_CODE).toContain("env.BLOBS");
  });

  it("derives its prefixes from the guarded builder, never inline", () => {
    expect(STEP_CODE).toContain("voicemailR2Prefixes(uid)");
    expect(STEP_CODE).not.toMatch(/`receptionist\/|`voicemail\//);
  });

  it("does not abandon the cascade when one prefix fails", () => {
    // Failure is RECORDED in stores_done ([DEL-LOUD-FAIL-1]), not thrown: an
    // R2 blip must not stop the Clerk/PostHog/finalize steps that follow.
    expect(STEP_CODE).toContain("_failed");
    expect(STEP_CODE).not.toContain("throw");
  });
});
