import { describe, it, expect } from "vitest";
import { validAadhaar, cleanAadhaar, mapGender, isAdult, nameScore, namesMatch, UPI_RE, IFSC_RE, ACCOUNT_RE, firstNameOf } from "./hf_kyc_util";

describe("hf_kyc_util", () => {
  it("validates Aadhaar checksum", () => {
    expect(validAadhaar("234567890124")).toBe(true);      // Verhoeff-valid test number
    expect(validAadhaar("234567890123")).toBe(false);
    expect(validAadhaar("123456789012")).toBe(false);     // starts with 1
    expect(cleanAadhaar("2345 6789 0124")).toBe("234567890124");
    expect(cleanAadhaar("abc")).toBeNull();
  });
  it("maps gender", () => {
    expect(mapGender("f")).toBe("F"); expect(mapGender("MALE")).toBe("M"); expect(mapGender("O")).toBe("T"); expect(mapGender("")).toBeNull();
  });
  it("computes adulthood", () => {
    const now = new Date(Date.UTC(2026, 9, 9));
    expect(isAdult("2008-10-09", null, now)).toBe(true);
    expect(isAdult("2008-10-10", null, now)).toBe(false);
    expect(isAdult(null, 2000, now)).toBe(true);
    expect(isAdult(null, 2010, now)).toBe(false);
    expect(isAdult(null, 2008, now)).toBeNull();
  });
  it("matches names", () => {
    expect(namesMatch("Rahul Sharma", "RAHUL KUMAR SHARMA")).toBe(true);
    expect(namesMatch("Rahul Sharma", "SHARMA R")).toBe(true);
    expect(namesMatch("Rahul Sharma", "PRIYA VERMA")).toBe(false);
    expect(nameScore("", "A")).toBe(0);
    expect(firstNameOf("MR PRIYA verma")).toBe("Priya");
  });
  it("formats", () => {
    expect(UPI_RE.test("priya.v@okhdfcbank")).toBe(true); expect(UPI_RE.test("bad@")).toBe(false);
    expect(IFSC_RE.test("HDFC0001234")).toBe(true); expect(ACCOUNT_RE.test("123456789012")).toBe(true);
  });
});
