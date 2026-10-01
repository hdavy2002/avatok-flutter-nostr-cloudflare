// [SAATHUM-FREEVIDEOS-AUTOFILL-1] Pure helpers of the YouTube → AI form autofill.
import { describe, it, expect } from "vitest";
import { cleanYoutubeText, parseAutofillJson, fallbackFromYoutube, guessCategory, fetchYoutubeMeta } from "../src/lib/free_video_autofill";

describe("cleanYoutubeText", () => {
  it("drops links, hashtags, mentions, timestamps and emoji", () => {
    const s = cleanYoutubeText("🙏 Live Satsang #premanand @channel 00:12 https://x.y/z  Subscribe ▶ now");
    expect(s).toBe("Live Satsang Subscribe now");
  });
});

describe("parseAutofillJson", () => {
  it("finds the JSON object inside chatter", () => {
    expect(parseAutofillJson('Sure! {"title":"A","description":"B","category":"bhajan"} done')).toEqual({ title: "A", description: "B", category: "bhajan" });
  });
  it("returns null for junk", () => { expect(parseAutofillJson("no json here")).toBeNull(); });
});

describe("guessCategory", () => {
  it("maps common words", () => {
    expect(guessCategory("Ganga Aarti live")).toBe("aarti");
    expect(guessCategory("Hanuman Chalisa 11 times")).toBe("bhajan");
    expect(guessCategory("Ekantik vartalap pravachan")).toBe("sermon");
    expect(guessCategory("random vlog")).toBeNull();
  });
});

describe("fallbackFromYoutube", () => {
  it("cleans and clips, keeps the original", () => {
    const r = fallbackFromYoutube({ title: "Live Satsang 01-10-2026 #live", description: "First para https://a.b\n\nSecond para", channel: "Ch", tags: [] });
    expect(r.source).toBe("youtube");
    expect(r.title).toBe("Live Satsang 01-10-2026");
    expect(r.description).toBe("First para");
    expect(r.category).toBe("satsang");
    expect(r.original.channel).toBe("Ch");
  });
});

describe("fetchYoutubeMeta", () => {
  it("uses the Data API when a key is set", async () => {
    const f = (async () => new Response(JSON.stringify({ items: [{ snippet: { title: "T", description: "D", channelTitle: "C", tags: ["x"] } }] }))) as unknown as typeof fetch;
    expect(await fetchYoutubeMeta({ YOUTUBE_API_KEY: "k" } as any, "abc", f)).toEqual({ title: "T", description: "D", channel: "C", tags: ["x"] });
  });
  it("falls back to oEmbed without a key", async () => {
    const f = (async () => new Response(JSON.stringify({ title: "OT", author_name: "OA" }))) as unknown as typeof fetch;
    expect(await fetchYoutubeMeta({} as any, "abc", f)).toEqual({ title: "OT", description: "", channel: "OA", tags: [] });
  });
});
