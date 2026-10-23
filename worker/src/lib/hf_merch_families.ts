// [HF-MERCH-STUDIO-2 2026-10-23] Product families (silhouette keys, spec section 5) and shop categories for the merch catalogue.
// Pure: kind (from lib/pod classification) + name -> family / category. No partner field names here.
import { classifyByName } from "./pod/printrove";

export type Family =
  | "tee" | "tee_long" | "vneck" | "polo" | "crop_top" | "hoodie" | "crop_hoodie" | "sweatshirt" | "jacket" | "joggers" | "shorts" | "tote"
  | "mug" | "bottle" | "phone_case" | "poster" | "notebook" | "popsocket" | "mousepad" | "mask" | "cap" | "other";

export const FAMILIES: readonly Family[] = [
  "tee", "tee_long", "vneck", "polo", "crop_top", "hoodie", "crop_hoodie", "sweatshirt", "jacket", "joggers", "shorts", "tote",
  "mug", "bottle", "phone_case", "poster", "notebook", "popsocket", "mousepad", "mask", "cap", "other",
];

const FAMILY_BY_KIND: Record<string, Family> = {
  mens_tee: "tee", womens_tee: "tee", kids_tee: "tee", toddler_tee: "tee", oversized_tee: "tee", tee: "tee",
  full_sleeve_tee: "tee_long", vneck_tee: "vneck", polo: "polo", crop_top: "crop_top", tank_top: "crop_top",
  hoodie: "hoodie", oversized_hoodie: "hoodie", crop_hoodie: "crop_hoodie", sweatshirt: "sweatshirt",
  bomber_jacket: "jacket", jacket: "jacket", joggers: "joggers", shorts: "shorts",
  tote_bag: "tote", mug: "mug", sipper_bottle: "bottle", phone_case: "phone_case", poster: "poster", notebook: "notebook",
  pop_socket: "popsocket", mouse_pad: "mousepad", mask: "mask", cap: "cap",
};

/** Silhouette family for a kind. A generic kind (`item` / `other` / unknown) is refined from the product name; anything unmatched is `other`. */
export function familyOf(kind: string, name?: string | null): Family {
  const direct = FAMILY_BY_KIND[kind];
  if (direct) return direct;
  if (name) {
    const k = classifyByName(name);
    if (k && FAMILY_BY_KIND[k]) return FAMILY_BY_KIND[k];
  }
  return "other";
}

export type MerchCategory = { slug: string; label: string };
/** Display order of the shop tabs. */
export const CATEGORY_ORDER: readonly MerchCategory[] = [
  { slug: "tshirts", label: "T-shirts" },
  { slug: "hoodies", label: "Hoodies & sweatshirts" },
  { slug: "bottoms", label: "Joggers & shorts" },
  { slug: "jackets", label: "Jackets" },
  { slug: "accessories", label: "Bags & accessories" },
  { slug: "home", label: "Home & desk" },
  { slug: "phone", label: "Phone" },
  { slug: "other", label: "More" },
];
const CAT = Object.fromEntries(CATEGORY_ORDER.map((c) => [c.slug, c])) as Record<string, MerchCategory>;
const CATEGORY_BY_KIND: Record<string, string> = {
  mens_tee: "tshirts", womens_tee: "tshirts", kids_tee: "tshirts", toddler_tee: "tshirts", oversized_tee: "tshirts", full_sleeve_tee: "tshirts",
  vneck_tee: "tshirts", polo: "tshirts", crop_top: "tshirts", tank_top: "tshirts", tee: "tshirts",
  hoodie: "hoodies", oversized_hoodie: "hoodies", crop_hoodie: "hoodies", sweatshirt: "hoodies",
  joggers: "bottoms", shorts: "bottoms", bomber_jacket: "jackets", jacket: "jackets",
  tote_bag: "accessories", cap: "accessories", mask: "accessories", keychain: "accessories", badge: "accessories", sticker: "accessories",
  mug: "home", sipper_bottle: "home", poster: "home", notebook: "home", mouse_pad: "home", coaster: "home", cushion: "home",
  phone_case: "phone", pop_socket: "phone",
};
export function categoryOf(kind: string): MerchCategory {
  return CAT[CATEGORY_BY_KIND[kind] ?? "other"];
}
export const categoryRank = (slug: string): number => {
  const i = CATEGORY_ORDER.findIndex((c) => c.slug === slug);
  return i < 0 ? CATEGORY_ORDER.length : i;
};
