import { describe, it, expect } from "vitest";
import { GST_STATES, gstStateCode, gstStateName } from "./gst_states";

describe("[HF-MERCH-GST-1] GST state codes", () => {
  it("maps the common names", () => {
    expect(gstStateCode("Maharashtra")).toBe("27");
    expect(gstStateCode("Uttarakhand")).toBe("05");
    expect(gstStateCode("Delhi")).toBe("07");
    expect(gstStateCode("Karnataka")).toBe("29");
    expect(gstStateCode("Tamil Nadu")).toBe("33");
    expect(gstStateCode("Telangana")).toBe("36");
    expect(gstStateCode("Andhra Pradesh")).toBe("37");
    expect(gstStateCode("Ladakh")).toBe("38");
  });
  it("is forgiving about case, punctuation, & and old names", () => {
    expect(gstStateCode("  MAHARASHTRA ")).toBe("27");
    expect(gstStateCode("jammu & kashmir")).toBe("01");
    expect(gstStateCode("Andaman & Nicobar Islands")).toBe("35");
    expect(gstStateCode("Orissa")).toBe("21");
    expect(gstStateCode("Uttaranchal")).toBe("05");
    expect(gstStateCode("Pondicherry")).toBe("34");
    expect(gstStateCode("NCT of Delhi")).toBe("07");
    expect(gstStateCode("Daman and Diu")).toBe("26");
    expect(gstStateCode("tamil-nadu")).toBe("33");
  });
  it("accepts a two-digit code", () => {
    expect(gstStateCode("27")).toBe("27");
    expect(gstStateCode("7")).toBe("07");
    expect(gstStateCode("25")).toBeNull();
    expect(gstStateCode("99")).toBeNull();
  });
  it("unknown or empty is null (the caller decides what that means)", () => {
    expect(gstStateCode("")).toBeNull();
    expect(gstStateCode(null)).toBeNull();
    expect(gstStateCode("Atlantis")).toBeNull();
  });
  it("the table has unique codes and names, and round-trips", () => {
    expect(new Set(GST_STATES.map((s) => s.code)).size).toBe(GST_STATES.length);
    for (const s of GST_STATES) { expect(gstStateCode(s.name)).toBe(s.code); expect(gstStateName(s.code)).toBe(s.name); }
  });
});
