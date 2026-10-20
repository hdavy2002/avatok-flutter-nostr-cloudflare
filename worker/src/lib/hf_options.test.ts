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
  it("keeps legacy topics and balances creator, everyday and interest starters", () => {
    expect(TOPICS).toHaveLength(46); // [HF-BOOK-APPROVE-BE] +3 fan-call topics (owner 2026-10-20)
    expect(TOPICS.slice(0, 6).map((t) => t.slug)).toEqual([
      "content-creation", "bas-baat-karni-hai", "music-and-movies",
      "behind-the-scenes", "roz-thodi-baat", "travel-and-food",
    ]);
    expect(TOPICS.filter((t) => t.group === "Creator life")).toHaveLength(9);
    for (const slug of ["talk-about-my-channel", "just-friendship", "general-advice"]) expect(TOPIC_SLUGS.has(slug)).toBe(true);
    expect(TOPICS.filter((t) => t.group === "Interests & hobbies")).toHaveLength(6);
    for (const slug of [
      "roz-thodi-baat", "koi-jo-mujhe-jaane", "shaam-ka-saathi", "ek-dost-jo-sune",
      "apni-bhasha-mein-dost", "kisi-topic-pe-baat", "apni-bhasha-mein-baat", "english-mein-casual-chat",
      "bas-baat-karni-hai", "aaj-akela-lag-raha-hai", "din-kharab-tha", "raat-ko-neend-nahi-aati",
      "shaam-ki-company", "ghar-ki-yaad-aa-rahi-hai", "kisi-se-share-karna-hai", "bore-ho-raha-hoon",
      "raat-ki-shift-koi-jaga-hai", "subah-ki-chai-thodi-baat", "mann-bhaari-hai", "exam-ki-tension",
      "interview-se-darr", "shaadi-ka-pressure", "ghar-waalon-se-jhagda", "naukri-ki-chinta", "breakup",
      "shaadi-ki-baatein", "naya-sheher-nayi-job", "paise-ki-tension", "bachchon-ki-padhai",
      "maa-baap-ki-sehat", "sehat-ki-chinta",
    ]) expect(TOPIC_SLUGS.has(slug)).toBe(true);
  });
  it("option tables are consistent", () => {
    expect(TOPIC_SLUGS.size).toBe(TOPICS.length);
    expect(Object.keys(LANGUAGE_CODES).length).toBe(LANGUAGES.length);
  });
});
