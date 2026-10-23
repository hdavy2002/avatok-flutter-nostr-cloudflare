// [HF-CHANNEL-CORE-1 2026-10-23] Fan-facing merch category (spec C2), derived from the frozen catalogue name / kind of a product.
// Self-contained on purpose: another lane (HF-MERCH-STUDIO-2) adds its own catalogue `category` to /catalog; this mapping only feeds the
// public channel page filter chips and never reads or writes that field. Pure: no I/O.
export const MERCH_PUBLIC_CATEGORIES = [
  { slug: "tshirts", label: "T-shirts" },
  { slug: "hoodies", label: "Hoodies" },
  { slug: "mugs", label: "Mugs" },
  { slug: "caps", label: "Caps" },
  { slug: "phone-covers", label: "Phone covers" },
  { slug: "bags", label: "Bags" },
  { slug: "posters", label: "Posters" },
  { slug: "other", label: "Other" },
] as const;
export type MerchPublicCategory = (typeof MERCH_PUBLIC_CATEGORIES)[number]["slug"];

// First match wins, so the more specific families (hoodie before tee, phone cover before bag) come first.
const RULES: Array<[MerchPublicCategory, RegExp]> = [
  ["hoodies", /\b(hoodie|hoodies|sweatshirt|sweatshirts|jumper|pullover|crewneck)\b/],
  ["phone-covers", /\b(phone|mobile|iphone|smartphone|samsung|case|cases)\b|\bcover\b/],
  ["mugs", /\b(mug|mugs|cup|cups|tumbler|tumblers)\b/],
  ["caps", /\b(cap|caps|hat|hats|beanie|beanies)\b/],
  ["bags", /\b(tote|totes|bag|bags|backpack|backpacks|pouch|sling)\b/],
  ["posters", /\b(poster|posters|canvas|framed|wall art)\b/],
  ["tshirts", /\b(tee|tees|t shirt|t shirts|tshirt|tshirts|shirt|shirts|polo|polos|tank|jersey|crop top|top)\b/],
];

const norm = (s: unknown): string => String(s ?? "").toLowerCase().replace(/[_\-/]+/g, " ").replace(/\s+/g, " ").trim();

export function merchPublicCategory(src: { catalogName?: string | null; kind?: string | null }): { category: MerchPublicCategory; categoryLabel: string } {
  const text = `${norm(src.catalogName)} | ${norm(src.kind)}`;
  const hit = RULES.find(([, re]) => re.test(text));
  const slug: MerchPublicCategory = hit ? hit[0] : "other";
  return { category: slug, categoryLabel: MERCH_PUBLIC_CATEGORIES.find((c) => c.slug === slug)!.label };
}
