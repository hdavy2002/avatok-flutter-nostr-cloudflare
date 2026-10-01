import { describe, expect, it } from "vitest";
import { validDob, validTob } from "./profile";

describe("astro profile validation", () => {
  it("accepts real dates and rejects impossible/future ones", () => {
    expect(validDob("1990-02-28")).toBe(true);
    expect(validDob("1990-02-30")).toBe(false);
    expect(validDob("1850-01-01")).toBe(false);
    expect(validDob("2999-01-01")).toBe(false);
    expect(validDob("90-1-1")).toBe(false);
  });
  it("validates HH:MM", () => {
    expect(validTob("06:05")).toBe(true);
    expect(validTob("24:00")).toBe(false);
    expect(validTob("6:05")).toBe(false);
  });
});
