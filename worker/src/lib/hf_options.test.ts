import { describe, it, expect } from "vitest";
import { contactLeak, makeSlug, slugBase, SLUG_RE, TOPICS, TOPIC_SLUGS, LANGUAGES, LANGUAGE_CODES } from "./hf_options";

describe("hf_options", () => {
  it("flags contact leaks", () => {
    for (const s of ["call 98765 43210", "+91 9876543210", "mail me a@b.com", "my @handle", "https://x.co", "find me on WhatsApp", "insta: meena", "visit meena.in", "dm me on telegram"]) expect(contactLeak(s)).toBe(true);
  });
  it("lets normal text through", () => {
    for (const s of ["I love chai and old Hindi songs.", "Available 7 to 10 in the evening", "Teacher for 12 years, mother of 2", ""]) expect(contactLeak(s)).toBe(false);
    expect(contactLeak(undefined)).toBe(false);
  });
  it("makes slugs", () => {
    expect(makeSlug("Meena Devi")).toMatch(SLUG_RE);
    expect(makeSlug("  ")).toMatch(/^host-[a-z0-9]{4}$/);
    expect(slugBase("Zoë K")).toBe("zoe");
    expect(slugBase("मीना")).toBe("host");
    expect(makeSlug("A")).not.toBe(makeSlug("A") + "x");
  });
  it("option tables are consistent", () => {
    expect(TOPIC_SLUGS.size).toBe(TOPICS.length);
    expect(Object.keys(LANGUAGE_CODES).length).toBe(LANGUAGES.length);
  });
});
