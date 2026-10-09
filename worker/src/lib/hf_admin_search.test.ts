import { describe, it, expect } from "vitest";
import { classifyAdminQuery, escapeLike, searchable } from "./hf_admin_search";

describe("classifyAdminQuery", () => {
  it("empty and whitespace", () => {
    expect(classifyAdminQuery("").type).toBe("empty");
    expect(classifyAdminQuery("   ").type).toBe("empty");
    expect(classifyAdminQuery(null).type).toBe("empty");
  });
  it("normalises every phone spelling to the same E.164", () => {
    for (const s of ["+91 98765 43210", "9876543210", "919876543210", "09876543210", "+91-98765-43210", "(98765) 43210"]) {
      const q = classifyAdminQuery(s);
      expect(q.type).toBe("phone");
      expect(q.e164).toBe("+919876543210");
      expect(q.suffix).toBe("9876543210");
    }
  });
  it("keeps international numbers and short suffixes", () => {
    expect(classifyAdminQuery("+44 7911 123456").e164).toBe("+447911123456");
    const short = classifyAdminQuery("3210987");
    expect(short.type).toBe("phone");
    expect(short.suffix).toBe("3210987");
  });
  it("too few or too many digits is not a phone", () => {
    expect(classifyAdminQuery("12345").type).toBe("name");
    expect(classifyAdminQuery("1234567890123456").type).toBe("name");
  });
  it("email is lowercased", () => {
    const q = classifyAdminQuery("  Priya@Example.COM ");
    expect(q.type).toBe("email");
    expect(q.text).toBe("priya@example.com");
    expect(classifyAdminQuery("priya@").type).toBe("email");
  });
  it("uid vs name", () => {
    expect(classifyAdminQuery("user_2abcDEF123xyz").type).toBe("uid");
    expect(classifyAdminQuery("Priya Sharma").type).toBe("name");
    expect(classifyAdminQuery("priya").type).toBe("name");
    expect(classifyAdminQuery("Chandrasekharanatha").type).toBe("name");
  });
  it("caps very long input", () => {
    expect(classifyAdminQuery("a".repeat(500)).text.length).toBe(80);
  });
});

describe("searchable / escapeLike", () => {
  it("names need two characters", () => {
    expect(searchable(classifyAdminQuery("a"))).toBe(false);
    expect(searchable(classifyAdminQuery("ab"))).toBe(true);
    expect(searchable(classifyAdminQuery(""))).toBe(false);
    expect(searchable(classifyAdminQuery("9876543210"))).toBe(true);
  });
  it("escapes wildcards", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });
});
