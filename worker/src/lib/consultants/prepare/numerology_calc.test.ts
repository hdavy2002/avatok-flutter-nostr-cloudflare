import { describe, it, expect } from "vitest";
import { reduceDigit, chaldeanTotal, nameTotals, mobileDigits, mobileTotal, dobNumbers, loShu, parseIsoDate, cleanLatinName } from "./numerology_calc";

describe("reduceDigit", () => {
  it("reduces to one digit", () => {
    expect(reduceDigit(9)).toBe(9);
    expect(reduceDigit(23)).toBe(5);
    expect(reduceDigit(99)).toBe(9);
    expect(reduceDigit(1999)).toBe(1);
    expect(reduceDigit(0)).toBe(0);
  });
});
describe("chaldean", () => {
  it("totals a name with compound and root", () => {
    // D4 A1 V6 Y1 = 12 -> 3
    expect(chaldeanTotal("Davy")).toEqual({ total: 12, root: 3 });
    // R2 A1 M4 = 7
    expect(chaldeanTotal("ram")).toEqual({ total: 7, root: 7 });
  });
  it("ignores spaces, punctuation and digits, case-insensitive", () => {
    expect(chaldeanTotal("D. a-v y 9")).toEqual(chaldeanTotal("DAVY"));
    expect(chaldeanTotal("")).toEqual({ total: 0, root: 0 });
  });
  it("nameTotals counts letters", () => {
    const t = nameTotals("  Sita Devi ");
    expect(t.letters).toBe(8);
    expect(t.name).toBe("Sita Devi");
    // S3 I1 T4 A1 =9 ; D4 E5 V6 I1 =16 -> 25 -> 7
    expect(t.total).toBe(25);
    expect(t.root).toBe(7);
  });
});
describe("mobile", () => {
  it("strips country code / trunk zero", () => {
    expect(mobileDigits("+91 98765 43210")).toBe("9876543210");
    expect(mobileDigits("098765-43210")).toBe("9876543210");
    expect(mobileDigits("9876543210")).toBe("9876543210");
  });
  it("totals digits", () => {
    // 9+8+7+6+5+4+3+2+1+0 = 45 -> 9
    expect(mobileTotal("+91 9876543210")).toEqual({ digits: "9876543210", total: 45, root: 9 });
  });
  it("rejects too-short input", () => { expect(mobileTotal("12345")).toBeNull(); expect(mobileTotal("")).toBeNull(); });
});
describe("dob numbers", () => {
  it("radical is birth day, destiny is whole date", () => {
    // 29-11-1990: day 29 -> 11 -> 2; digits 2+9+1+1+1+9+9+0 = 32 -> 5
    const n = dobNumbers("1990-11-29")!;
    expect(n.radical).toEqual({ total: 29, root: 2 });
    expect(n.destiny).toEqual({ total: 32, root: 5 });
  });
  it("rejects invalid dates", () => {
    expect(dobNumbers("1990-02-31")).toBeNull();
    expect(parseIsoDate("nope")).toBeNull();
  });
});
describe("loShu", () => {
  it("places repeated digits and lists missing ones", () => {
    const l = loShu("1990-11-29")!; // digits 2 9 1 1 1 9 9 (0 ignored)
    expect(l.counts["1"]).toBe(3);
    expect(l.counts["9"]).toBe(3);
    expect(l.counts["2"]).toBe(1);
    expect(l.grid[0]).toEqual(["", "999", "2"]);
    expect(l.grid[2]).toEqual(["", "111", ""]);
    expect(l.missing).toEqual([3, 4, 5, 6, 7, 8]);
  });
});
describe("cleanLatinName", () => {
  it("accepts English letters and rejects Devanagari", () => {
    expect(cleanLatinName("  Davy   Kumar ")).toBe("Davy Kumar");
    expect(cleanLatinName("डेवी")).toBeNull();
    expect(cleanLatinName("A")).toBeNull();
  });
});
