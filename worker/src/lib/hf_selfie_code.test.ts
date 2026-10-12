import { describe, expect, it, vi, afterEach } from "vitest";
import { newSelfieCode, validSelfieCode } from "./hf_kyc_util";

afterEach(() => vi.restoreAllMocks());
describe("six-digit video KYC challenge", () => {
  it("preserves leading zeroes and produces exactly six digits", () => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => { (array as Uint32Array)[0] = 42; return array; });
    expect(newSelfieCode()).toBe("000042");
    expect(validSelfieCode(newSelfieCode())).toBe(true);
  });
  it("rejects old four-digit codes and numeric coercion", () => {
    for (const value of ["1234", "12345", "1234567", " 123456", "12345x", 123456, null]) expect(validSelfieCode(value)).toBe(false);
    expect(validSelfieCode("012345")).toBe(true);
  });
  it("discards the biased upper remainder", () => {
    let call = 0;
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => { (array as Uint32Array)[0] = call++ === 0 ? 0xffffffff : 999999; return array; });
    expect(newSelfieCode()).toBe("999999");
    expect(call).toBe(2);
  });
});
