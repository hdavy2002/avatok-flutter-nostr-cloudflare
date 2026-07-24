// [TEST-FAILURE-INJECT-1] shouldFail() parsing — the single decision point every
// injection call site in the codebase routes through. Must be an unconditional
// no-op whenever env.FAULT_INJECT is unset (i.e. every deployed environment
// today), and must never be reachable via a KV/config flag (see fault_inject.ts's
// header comment) — this test only exercises the env-var parsing contract.
import { describe, it, expect } from "vitest";
import { shouldFail } from "../src/lib/fault_inject";

function envWith(v: string | undefined): any {
  return v === undefined ? {} : { FAULT_INJECT: v };
}

describe("shouldFail", () => {
  it("is false when FAULT_INJECT is unset (the default/production state)", () => {
    expect(shouldFail(envWith(undefined), "media_upload_private")).toBe(false);
  });
  it("is false for an empty string", () => {
    expect(shouldFail(envWith(""), "media_upload_private")).toBe(false);
  });
  it("is true when the point is named exactly", () => {
    expect(shouldFail(envWith("media_upload_private"), "media_upload_private")).toBe(true);
  });
  it("parses a comma-separated list and matches any member", () => {
    const env = envWith("inbox_append,ai_reserve,openrouter_call");
    expect(shouldFail(env, "ai_reserve")).toBe(true);
    expect(shouldFail(env, "inbox_append")).toBe(true);
    expect(shouldFail(env, "openrouter_call")).toBe(true);
    expect(shouldFail(env, "ai_settle")).toBe(false);
  });
  it("trims whitespace around list entries", () => {
    expect(shouldFail(envWith(" ai_reserve , ai_settle "), "ai_settle")).toBe(true);
  });
  it("ignores empty entries from stray commas", () => {
    expect(shouldFail(envWith("ai_reserve,,ai_settle,"), "ai_settle")).toBe(true);
  });
  it("is false for a point name that is only a substring of a configured point", () => {
    expect(shouldFail(envWith("ai_reserve"), "ai_reserve_extra")).toBe(false);
    expect(shouldFail(envWith("ai_reserve"), "reserve")).toBe(false);
  });
  it("is false when FAULT_INJECT is a non-string value", () => {
    expect(shouldFail({ FAULT_INJECT: 1 as any }, "ai_reserve")).toBe(false);
    expect(shouldFail({ FAULT_INJECT: null as any }, "ai_reserve")).toBe(false);
  });
});
