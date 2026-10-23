import { describe, it, expect } from "vitest";
import { categoryOf, categoryRank, familyOf, CATEGORY_ORDER } from "./hf_merch_families";

describe("familyOf", () => {
  it("maps kinds to silhouette families", () => {
    const t: Record<string, string> = {
      mens_tee: "tee", womens_tee: "tee", kids_tee: "tee", toddler_tee: "tee", oversized_tee: "tee", full_sleeve_tee: "tee_long", vneck_tee: "vneck", polo: "polo",
      crop_top: "crop_top", tank_top: "crop_top", hoodie: "hoodie", oversized_hoodie: "hoodie", crop_hoodie: "crop_hoodie", sweatshirt: "sweatshirt",
      bomber_jacket: "jacket", jacket: "jacket", joggers: "joggers", shorts: "shorts", tote_bag: "tote", mug: "mug", sipper_bottle: "bottle", phone_case: "phone_case",
      poster: "poster", notebook: "notebook", pop_socket: "popsocket", mouse_pad: "mousepad", mask: "mask", cap: "cap", coaster: "other", cushion: "other", badge: "other",
    };
    for (const [k, f] of Object.entries(t)) expect([k, familyOf(k, "x")]).toEqual([k, f]);
  });
  it("refines a generic kind from the name and defaults to other", () => {
    expect(familyOf("item", "Steel Sipper Bottle")).toBe("bottle");
    expect(familyOf("item", "Mystery")).toBe("other");
    expect(familyOf("other")).toBe("other");
  });
});

describe("categoryOf", () => {
  it("groups kinds into shop categories", () => {
    expect(categoryOf("mens_tee")).toEqual({ slug: "tshirts", label: "T-shirts" });
    expect(categoryOf("polo").slug).toBe("tshirts");
    expect(categoryOf("sweatshirt")).toEqual({ slug: "hoodies", label: "Hoodies & sweatshirts" });
    expect(categoryOf("shorts")).toEqual({ slug: "bottoms", label: "Joggers & shorts" });
    expect(categoryOf("bomber_jacket")).toEqual({ slug: "jackets", label: "Jackets" });
    expect(categoryOf("tote_bag")).toEqual({ slug: "accessories", label: "Bags & accessories" });
    expect(categoryOf("mug")).toEqual({ slug: "home", label: "Home & desk" });
    expect(categoryOf("phone_case")).toEqual({ slug: "phone", label: "Phone" });
    expect(categoryOf("item")).toEqual({ slug: "other", label: "More" });
  });
  it("has a stable order", () => {
    expect(CATEGORY_ORDER.map((c) => c.slug)).toEqual(["tshirts", "hoodies", "bottoms", "jackets", "accessories", "home", "phone", "other"]);
    expect(categoryRank("home")).toBeLessThan(categoryRank("other"));
  });
});
