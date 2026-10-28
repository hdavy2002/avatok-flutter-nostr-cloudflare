// [HF-INTRO-W1] HF-INTRO-2 / D2: the ONE category catalogue for influencer onboarding (web, app and admin read it from
// GET /api/hf/onboarding/categories). Normal categories first; Listener, Prayer, Virtual friend and Women-to-Women are
// ALWAYS the last four, in that order. LGBTQ+ is deliberately not offered here (existing LGBTQ+ channels are untouched).

export interface HfCategory { id: string; label: string; sensitive: boolean }

const NORMAL: readonly [string, string][] = [
  ["astrology", "Astrology"], ["teacher", "Teacher"], ["traveller", "Traveller"], ["cook", "Cook"], ["fitness", "Fitness"],
  ["music", "Music"], ["beauty", "Beauty"], ["tech", "Tech"], ["comedy", "Comedy"], ["spirituality", "Spirituality"],
  ["career", "Career"], ["health_wellness", "Health & Wellness"], ["language", "Language"], ["gaming", "Gaming"], ["other", "Other"],
];
const SENSITIVE: readonly [string, string][] = [
  ["listener", "Listener"], ["prayer", "Prayer"], ["virtual_friend", "Virtual friend"], ["women_to_women", "Women-to-Women"],
];

export const HF_CATEGORIES: readonly HfCategory[] = [
  ...NORMAL.map(([id, label]) => ({ id, label, sensitive: false })),
  ...SENSITIVE.map(([id, label]) => ({ id, label, sensitive: true })),
];

const BY_ID = new Map(HF_CATEGORIES.map((c) => [c.id, c]));

export const WOMEN_TO_WOMEN = "women_to_women";
export const isCategoryId = (v: unknown): v is string => typeof v === "string" && BY_ID.has(v);
/** Listener / Prayer / Virtual friend / Women-to-Women: these need Aadhaar (D4). */
export const isSensitiveCategory = (id: unknown): boolean => typeof id === "string" && BY_ID.get(id)?.sensitive === true;
export const categoryLabel = (id: string): string => BY_ID.get(id)?.label ?? id;
export const MAX_CATEGORIES = HF_CATEGORIES.length;

/** Valid, de-duplicated category ids in catalogue order; null when the input is not a non-empty array of known ids. */
export function normalizeCategories(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_CATEGORIES || !v.every(isCategoryId)) return null;
  const set = new Set(v as string[]);
  return HF_CATEGORIES.filter((c) => set.has(c.id)).map((c) => c.id);
}

/** Parse a stored categories_json into [{id,label}] (unknown ids dropped). */
export function categoriesFromJson(s: unknown): { id: string; label: string }[] {
  try {
    const v = JSON.parse(String(s ?? "[]"));
    return Array.isArray(v) ? v.filter(isCategoryId).map((id) => ({ id, label: categoryLabel(id) })) : [];
  } catch { return []; }
}
