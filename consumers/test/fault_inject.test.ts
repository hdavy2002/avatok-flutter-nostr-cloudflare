// [TEST-FAILURE-INJECT-1] shouldFail() parsing — consumers copy of the worker
// test (consumers/src/fault_inject.ts is a deliberate duplicate, not a shared
// import — see its header comment for why). Same contract, same coverage.
import { describe, it, expect } from "vitest";
import { shouldFail } from "../src/fault_inject";

function envWith(v: string | undefined): any {
  return v === undefined ? {} : { FAULT_INJECT: v };
}

describe("shouldFail (consumers)", () => {
  it("is false when FAULT_INJECT is unset", () => {
    expect(shouldFail(envWith(undefined), "fanout_recipient")).toBe(false);
  });
  it("is true when the point is named", () => {
    expect(shouldFail(envWith("fanout_recipient"), "fanout_recipient")).toBe(true);
  });
  it("parses a comma-separated list", () => {
    expect(shouldFail(envWith("a,fanout_recipient,b"), "fanout_recipient")).toBe(true);
    expect(shouldFail(envWith("a,b"), "fanout_recipient")).toBe(false);
  });
  it("trims whitespace", () => {
    expect(shouldFail(envWith(" fanout_recipient "), "fanout_recipient")).toBe(true);
  });
});
