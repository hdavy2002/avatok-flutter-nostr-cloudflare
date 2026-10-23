// [HF-CHANNEL-CORE-1] The public category mapping the channel page filter chips use.
import { describe, it, expect } from "vitest";
import { merchPublicCategory } from "./hf_merch_public_category";

const c = (catalogName: string, kind = "") => merchPublicCategory({ catalogName, kind });

describe("merchPublicCategory", () => {
  it("maps the T-shirt family", () => {
    for (const n of ["Men's T-shirt", "Oversized T-shirt", "Women's T-shirt", "Polo T-shirt", "Crop top", "V-neck T-shirt", "Full sleeve T-shirt"]) expect(c(n).category).toBe("tshirts");
    expect(c("", "mens_tee")).toEqual({ category: "tshirts", categoryLabel: "T-shirts" });
    expect(c("Round Neck Tee", "kids_tee").category).toBe("tshirts");
  });
  it("hoodies and sweatshirts win over crop / tee words", () => {
    expect(c("Hoodie")).toEqual({ category: "hoodies", categoryLabel: "Hoodies" });
    expect(c("Crop hoodie", "crop_hoodie").category).toBe("hoodies");
    expect(c("Sweatshirt").category).toBe("hoodies");
  });
  it("maps the other product families", () => {
    expect(c("Ceramic Mug 330ml").category).toBe("mugs");
    expect(c("Baseball Cap").category).toBe("caps");
    expect(c("iPhone 15 Phone Cover")).toEqual({ category: "phone-covers", categoryLabel: "Phone covers" });
    expect(c("Canvas Tote Bag").category).toBe("bags");
    expect(c("A3 Poster").category).toBe("posters");
  });
  it("unknown or empty falls back to other", () => {
    expect(c("Sticker pack")).toEqual({ category: "other", categoryLabel: "Other" });
    expect(merchPublicCategory({})).toEqual({ category: "other", categoryLabel: "Other" });
    expect(merchPublicCategory({ catalogName: null, kind: null }).category).toBe("other");
  });
  it("does not match inside longer words", () => {
    expect(c("Capture frame").category).toBe("other");
  });
});
