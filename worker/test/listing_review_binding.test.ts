import { describe, expect, it } from "vitest";
import { reviewedContentHash } from "../src/routes/listings";

// [LIST-REVIEW-BINDING-1] Second half of C02 — an approval must be bound to the
// content it approved. These tests pin down reviewedContentHash()'s contract:
// deterministic over MATERIAL fields, blind to server-owned/non-material noise,
// and sensitive to every field a reviewer actually judged.

describe("reviewedContentHash", () => {
  const base = {
    title: "Sunrise Yoga",
    description: "A gentle 60-minute flow for all levels.",
    category: "yoga",
    price: 500,
    currency_display: "INR",
    cover_media: JSON.stringify([{ type: "image", url: "https://example.com/a.jpg" }]),
    starts_at: 1_700_000_000_000,
    duration_min: 60,
    capacity: 20,
    free_entry: 0,
    attrs: JSON.stringify({ level: "beginner", mat_required: true }),
  };

  it("is deterministic for identical content", async () => {
    const a = await reviewedContentHash({ ...base });
    const b = await reviewedContentHash({ ...base });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is insensitive to attrs key order (canonical serialisation)", async () => {
    const attrsA = JSON.stringify({ level: "beginner", mat_required: true });
    const attrsB = JSON.stringify({ mat_required: true, level: "beginner" });
    const a = await reviewedContentHash({ ...base, attrs: attrsA });
    const b = await reviewedContentHash({ ...base, attrs: attrsB });
    expect(a).toBe(b);
  });

  it("accepts attrs as an already-parsed object, matching the JSON-string form", async () => {
    const asString = await reviewedContentHash({ ...base, attrs: JSON.stringify({ level: "beginner", mat_required: true }) });
    const asObject = await reviewedContentHash({ ...base, attrs: { level: "beginner", mat_required: true } });
    expect(asString).toBe(asObject);
  });

  it("accepts cover_media as an already-parsed array, matching the JSON-string form", async () => {
    const arr = [{ type: "image", url: "https://example.com/a.jpg" }];
    const asString = await reviewedContentHash({ ...base, cover_media: JSON.stringify(arr) });
    const asArray = await reviewedContentHash({ ...base, cover_media: arr });
    expect(asString).toBe(asArray);
  });

  // --- EXCLUSIONS: these must NEVER change the hash ---

  it("ignores attrs.poster — server-owned moderation state", async () => {
    const withoutPoster = await reviewedContentHash({ ...base });
    const withPoster = await reviewedContentHash({
      ...base,
      attrs: JSON.stringify({ level: "beginner", mat_required: true, poster: { status: "approved", generated_at: 123, attempt: 1 } }),
    });
    expect(withoutPoster).toBe(withPoster);
  });

  it("a poster regeneration (only attrs.poster changes) never invalidates the hash", async () => {
    const gen1 = await reviewedContentHash({
      ...base,
      attrs: JSON.stringify({ level: "beginner", mat_required: true, poster: { status: "generating", attempt: 1 } }),
    });
    const gen2 = await reviewedContentHash({
      ...base,
      attrs: JSON.stringify({ level: "beginner", mat_required: true, poster: { status: "approved", attempt: 2, generated_at: 999 } }),
    });
    expect(gen1).toBe(gen2);
  });

  it("ignores fields outside REVIEW_MATERIAL_FIELDS (status, counters, timestamps)", async () => {
    const a = await reviewedContentHash({ ...base });
    const b = await reviewedContentHash({
      ...base,
      status: "published",
      view_count: 9999,
      favourite_count: 42,
      rating_avg: 4.8,
      rating_count: 12,
      created_at: 1,
      updated_at: 2,
      content_version: 7,
      cat_version: 3,
      section: "wellness",
      slug: "sunrise-yoga",
      blurb: "namaste",
      video_url: "https://youtube.com/x",
      vibe_tags: JSON.stringify(["safe_space"]),
    });
    expect(a).toBe(b);
  });

  // --- INCLUSIONS: each of these must change the hash ---

  const materialEdits: Array<[string, Record<string, unknown>]> = [
    ["title", { title: "Sunset Yoga" }],
    ["description", { description: "Different description entirely." }],
    ["category", { category: "fitness" }],
    ["price", { price: 750 }],
    ["currency_display", { currency_display: "USD" }],
    ["cover_media", { cover_media: JSON.stringify([{ type: "image", url: "https://example.com/b.jpg" }]) }],
    ["cover_media order", { cover_media: JSON.stringify([{ type: "image", url: "https://example.com/z.jpg" }, { type: "image", url: "https://example.com/a.jpg" }]) }],
    ["starts_at", { starts_at: 1_800_000_000_000 }],
    ["duration_min", { duration_min: 90 }],
    ["capacity", { capacity: 5 }],
    ["free_entry", { free_entry: 1 }],
    ["attrs (creator-owned key)", { attrs: JSON.stringify({ level: "advanced", mat_required: true }) }],
  ];

  it.each(materialEdits)("changing %s changes the hash", async (_label, edit) => {
    const original = await reviewedContentHash({ ...base });
    const edited = await reviewedContentHash({ ...base, ...edit });
    expect(edited).not.toBe(original);
  });
});
