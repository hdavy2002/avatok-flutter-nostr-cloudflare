// [HF-AVATAR-FILL-1] Pure plan builder for "fill the avatar catalogue to N each".
export const AVATAR_GENDERS = ["woman", "man"] as const;
export const AVATAR_AGES = ["20s", "30s", "40s", "50s+"] as const;
export const AVATAR_LOOKS = ["traditional", "casual", "office"] as const;

export type AvatarGender = (typeof AVATAR_GENDERS)[number];
export type AvatarAge = (typeof AVATAR_AGES)[number];
export type AvatarLook = (typeof AVATAR_LOOKS)[number];
export interface AvatarPlanEntry { gender: AvatarGender; age: AvatarAge; look: AvatarLook; count: number }
export interface AvatarCountRow { gender: string; age_band: string; look: string; n: number }

export const MAX_PLAN_ENTRIES = 24;
export const MAX_PLAN_ENTRY_COUNT = 12;
export const MAX_PLAN_TOTAL = 120;

/** Missing-to-target entries for every gender x age x look combination (zero entries skipped). */
export function buildAvatarFillPlan(existing: AvatarCountRow[], target: number): AvatarPlanEntry[] {
  const t = Math.max(1, Math.min(8, Math.trunc(Number(target) || 4)));
  const have = new Map<string, number>();
  for (const r of existing) {
    const k = `${r.gender}|${r.age_band}|${r.look}`;
    have.set(k, (have.get(k) ?? 0) + Math.max(0, Number(r.n) || 0));
  }
  const plan: AvatarPlanEntry[] = [];
  for (const gender of AVATAR_GENDERS) for (const age of AVATAR_AGES) for (const look of AVATAR_LOOKS) {
    const missing = t - (have.get(`${gender}|${age}|${look}`) ?? 0);
    if (missing > 0) plan.push({ gender, age, look, count: Math.min(MAX_PLAN_ENTRY_COUNT, missing) });
  }
  return plan;
}

export const planTotal = (plan: AvatarPlanEntry[]): number => plan.reduce((s, e) => s + e.count, 0);

/** Validates an untrusted plan from workflow params; returns null when invalid. */
export function sanitizeAvatarPlan(raw: unknown): AvatarPlanEntry[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PLAN_ENTRIES) return null;
  const out: AvatarPlanEntry[] = [];
  for (const e of raw as any[]) {
    const count = Math.trunc(Number(e?.count));
    if (!(AVATAR_GENDERS as readonly string[]).includes(e?.gender) || !(AVATAR_AGES as readonly string[]).includes(e?.age) ||
      !(AVATAR_LOOKS as readonly string[]).includes(e?.look) || !(count >= 1 && count <= MAX_PLAN_ENTRY_COUNT)) return null;
    out.push({ gender: e.gender, age: e.age, look: e.look, count });
  }
  return planTotal(out) <= MAX_PLAN_TOTAL ? out : null;
}
