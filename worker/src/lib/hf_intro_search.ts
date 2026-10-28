// [HF-SEARCH-FILTERS-1] Search + filters over the APPROVED intro influencers (flag hfIntroReelsEnabled), shared by the web Explore page and the app Search screen.
// Owner decisions 2026-10-28: list only hosts with intro_approved_at set and status approved/live; offline influencers ARE listed (button "Book a time", the
// card's mainAction / callState come from introReelItems, same as the Reels feed). ONE query box matches display name, @handle, verified YouTube / Instagram /
// Facebook handle (hf_channels approved + login-verified), category id / label, language, and words of the description. No gender filter exists.
//
// Query params (all optional, all public):
//   q            words; every word must match at least one of the fields above (AND across words, OR across fields)
//   category     comma list of category ids (hf_categories.ts); any-of
//   lang         comma list of language codes ("hi") or names ("Hindi"); any-of
//   avail        online (call option B and Online/Busy now) | bookings (call option A, or mode bookings_only)
//   priceMin / priceMax   rupees per minute, inclusive
//   verified     comma list of youtube | instagram | facebook; any-of, only accounts proven by that platform's own login
//   women        1 -> Women-only channels
//   sort         recommended (default) | online | price_low | newest
//   limit (<=30, default 20) / offset
// Old app builds keep working: platform=youtube|instagram maps to verified, space=women maps to women, and topic / kyc / space=lgbtq are accepted but ignored.
import type { Env } from "../types";
import { HF_CATEGORIES, isCategoryId } from "./hf_categories";
import { LANGUAGES, LANGUAGE_CODES, LANGUAGE_TO_CODE } from "./hf_options";
import { introReelItems } from "./hf_intro_reels";

export type IntroSort = "recommended" | "online" | "price_low" | "newest";
export type VerifiedPlat = "youtube" | "instagram" | "facebook";
export const VERIFIED_PLATS: readonly VerifiedPlat[] = ["youtube", "instagram", "facebook"];
export const INTRO_SORTS: readonly IntroSort[] = ["recommended", "online", "price_low", "newest"];
export const INTRO_PAGE_MAX = 30;

export interface IntroSearchQuery {
  q: string; words: string[]; categories: string[]; langs: string[]; avail: "" | "online" | "bookings";
  priceMin: number | null; priceMax: number | null; verified: VerifiedPlat[]; women: boolean; sort: IntroSort; limit: number; offset: number;
}

const list = (v: string | null): string[] => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 24);
const rupees = (v: string | null): number | null => {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.floor(n) : null;
};
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

/** Language code or name -> { code, name } or null. */
export function normLang(v: string): { code: string; name: string } | null {
  const s = v.trim();
  if (!s) return null;
  const byCode = LANGUAGE_CODES[s.toLowerCase()];
  if (byCode) return { code: s.toLowerCase(), name: byCode };
  const name = LANGUAGES.find((l) => l.toLowerCase() === s.toLowerCase());
  return name ? { code: LANGUAGE_TO_CODE[name], name } : null;
}

export function parseIntroSearch(sp: URLSearchParams): IntroSearchQuery {
  const q = (sp.get("q") ?? "").trim().slice(0, 80);
  const words = q.replace(/^@/, "").toLowerCase().split(/\s+/).map((w) => w.replace(/^@/, "")).filter(Boolean).slice(0, 6);
  const categories = [...new Set(list(sp.get("category")).filter(isCategoryId))];
  const langs = [...new Set(list(sp.get("lang")).map((l) => normLang(l)?.code).filter((c): c is string => !!c))];
  const availRaw = (sp.get("avail") ?? "").trim().toLowerCase();
  const avail = availRaw === "online" || availRaw === "bookings" ? availRaw : "";
  let priceMin = rupees(sp.get("priceMin")), priceMax = rupees(sp.get("priceMax"));
  if (priceMin != null && priceMax != null && priceMin > priceMax) [priceMin, priceMax] = [priceMax, priceMin];
  const verified = new Set<VerifiedPlat>(list(sp.get("verified")).map((s) => s.toLowerCase()).filter((s): s is VerifiedPlat => (VERIFIED_PLATS as readonly string[]).includes(s)));
  const legacyPlat = (sp.get("platform") ?? "").trim().toLowerCase(); // old app builds
  if (!verified.size && (legacyPlat === "youtube" || legacyPlat === "instagram")) verified.add(legacyPlat);
  const women = sp.get("women") === "1" || (sp.get("space") ?? "").trim() === "women";
  const sortRaw = (sp.get("sort") ?? "").trim().toLowerCase();
  const sort = (INTRO_SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as IntroSort) : "recommended";
  const limit = Math.min(INTRO_PAGE_MAX, Math.max(1, Math.trunc(Number(sp.get("limit"))) || 20));
  const offset = Math.min(5000, Math.max(0, Math.trunc(Number(sp.get("offset"))) || 0));
  return { q, words, categories, langs, avail, priceMin, priceMax, verified: [...verified], women, sort, limit, offset };
}

/** True when any narrowing parameter is on (the screens use it to switch from the home view to the results view). */
export const isFiltered = (f: IntroSearchQuery): boolean =>
  !!(f.words.length || f.categories.length || f.langs.length || f.avail || f.priceMin != null || f.priceMax != null || f.verified.length || f.women);

const OAUTH = `c.status='approved' AND c.verified_at IS NOT NULL AND c.provider_ref = (c.platform || '-oauth') AND c.platform IN ('youtube','instagram','facebook')`;

/** Pure: the WHERE / ORDER BY of the intro listing (exported for tests). */
export function buildIntroWhere(f: IntroSearchQuery): { where: string; binds: unknown[]; order: string } {
  const binds: unknown[] = [];
  const seen = new Map<unknown, string>(); // D1 allows 100 bound values: an equal value is bound once
  const bind = (v: unknown) => { const k = seen.get(v); if (k) return k; binds.push(v); const n = `?${binds.length}`; seen.set(v, n); return n; };
  const w: string[] = [`v.status='approved'`, `h.intro_approved_at IS NOT NULL`, `h.status IN ('approved','live')`, `h.slug IS NOT NULL`, `h.call_option IN ('A','B')`];
  for (const word of f.words) {
    const like = bind(`%${likeEsc(word)}%`);
    const or: string[] = [
      `LOWER(h.display_name) LIKE ${like} ESCAPE '\\'`,
      `LOWER(h.slug) LIKE ${like} ESCAPE '\\'`,
      `LOWER(h.about) LIKE ${like} ESCAPE '\\'`,
      `LOWER(h.tagline) LIKE ${like} ESCAPE '\\'`,
      `EXISTS (SELECT 1 FROM hf_user_registration r WHERE r.uid=h.uid AND LOWER(r.username) LIKE ${like} ESCAPE '\\')`,
      `EXISTS (SELECT 1 FROM hf_channels c WHERE c.host_uid=h.uid AND ${OAUTH} AND (LOWER(REPLACE(c.handle,'@','')) LIKE ${like} ESCAPE '\\' OR c.platform LIKE ${like} ESCAPE '\\'))`,
    ];
    for (const c of HF_CATEGORIES) {
      if (c.id.includes(word) || c.label.toLowerCase().includes(word)) or.push(`h.categories_json LIKE ${bind(`%"${c.id}"%`)}`);
    }
    for (const name of LANGUAGES) {
      const code = LANGUAGE_TO_CODE[name];
      if (name.toLowerCase().startsWith(word) || code === word) or.push(`(h.languages_json LIKE ${bind(`%"${code}"%`)} OR h.languages_json LIKE ${bind(`%"${name}"%`)})`);
    }
    w.push(`(${or.join(" OR ")})`);
  }
  if (f.categories.length) w.push(`(${f.categories.map((id) => `h.categories_json LIKE ${bind(`%"${id}"%`)}`).join(" OR ")})`);
  if (f.langs.length) w.push(`(${f.langs.map((code) => `(h.languages_json LIKE ${bind(`%"${code}"%`)} OR h.languages_json LIKE ${bind(`%"${LANGUAGE_CODES[code]}"%`)})`).join(" OR ")})`);
  if (f.avail === "online") w.push(`(h.call_option='B' AND h.presence IN ('online','busy') AND COALESCE(h.call_mode,'online') NOT IN ('offline','bookings_only'))`);
  if (f.avail === "bookings") w.push(`(h.call_option='A' OR COALESCE(h.call_mode,'online')='bookings_only')`);
  if (f.priceMin != null) w.push(`h.price_per_min >= ${bind(f.priceMin)}`);
  if (f.priceMax != null) w.push(`h.price_per_min <= ${bind(f.priceMax)}`);
  if (f.verified.length) w.push(`EXISTS (SELECT 1 FROM hf_channels c WHERE c.host_uid=h.uid AND ${OAUTH} AND c.platform IN (${f.verified.map((p) => bind(p)).join(",")}))`);
  if (f.women) w.push(`h.women_lane=1`);
  const rank = `CASE WHEN h.presence='online' THEN 0 WHEN h.presence='busy' THEN 1 ELSE 2 END`;
  const socials = `(SELECT COUNT(*) FROM hf_channels c WHERE c.host_uid=h.uid AND ${OAUTH})`;
  const order = f.sort === "online" ? `${rank}, LOWER(h.display_name), v.id`
    : f.sort === "price_low" ? `h.price_per_min ASC, ${rank}, h.intro_approved_at DESC, v.id DESC`
    : f.sort === "newest" ? `h.intro_approved_at DESC, v.id DESC`
    : `${rank}, ${socials} DESC, h.intro_approved_at DESC, v.id DESC`;
  return { where: w.join(" AND "), binds, order };
}

/** Stored languages (codes "hi" or names "Hindi") as display names, de-duplicated. */
export function languageNames(json: unknown): string[] {
  try {
    const v = JSON.parse(String(json ?? "[]"));
    if (!Array.isArray(v)) return [];
    const out = v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => LANGUAGE_CODES[x.trim().toLowerCase()] ?? (x.trim().charAt(0).toUpperCase() + x.trim().slice(1)));
    return [...new Set(out)];
  } catch { return []; }
}

export interface IntroSearchResult { items: Record<string, unknown>[]; total: number; nextOffset: number | null }

/** The filtered, sorted, paged intro cards. Same card shape as the Reels feed (kind 'intro'), plus `languages`. */
export async function introSearch(env: Env, f: IntroSearchQuery): Promise<IntroSearchResult> {
  const b = buildIntroWhere(f);
  const from = `FROM hf_intro_videos v JOIN hf_hosts h ON h.intro_video_id=v.id WHERE ${b.where}`;
  const total = Number((await env.DB_META.prepare(`SELECT COUNT(*) AS c ${from}`).bind(...b.binds).first<{ c: number }>())?.c ?? 0);
  const ids = ((await env.DB_META.prepare(`SELECT v.id AS id ${from} ORDER BY ${b.order} LIMIT ${f.limit} OFFSET ${f.offset}`).bind(...b.binds).all<{ id: string }>()).results ?? []).map((r) => r.id);
  if (!ids.length) return { items: [], total, nextOffset: null };
  const { items } = await introReelItems(env, { ids, ignoreVisibility: true, limit: ids.length });
  const slugs = items.map((i) => String((i.host as { slug?: string } | undefined)?.slug ?? "")).filter(Boolean);
  const langBy = new Map<string, string[]>();
  if (slugs.length) {
    const rows = (await env.DB_META.prepare(`SELECT slug, languages_json FROM hf_hosts WHERE slug IN (${slugs.map((_, i) => `?${i + 1}`).join(",")})`).bind(...slugs).all<{ slug: string; languages_json: string | null }>()).results ?? [];
    for (const r of rows) langBy.set(r.slug, languageNames(r.languages_json));
  }
  const byId = new Map<string, Record<string, unknown>>(items.map((i) => [String(i.id), { ...i, languages: langBy.get(String((i.host as { slug?: string }).slug)) ?? [] }]));
  const ordered = ids.map((id) => byId.get(id)).filter((i): i is Record<string, unknown> => !!i);
  const end = f.offset + ids.length;
  return { items: ordered, total, nextOffset: end < total ? end : null };
}

/** Old-app shape (`online[]` / `offline[]` of GET /api/hf/search) built from intro cards, so builds that predate the filters keep rendering. */
export function legacyHosts(items: Record<string, unknown>[]): { online: Record<string, unknown>[]; offline: Record<string, unknown>[] } {
  const hosts = items.map((i) => {
    const h = (i.host ?? {}) as Record<string, unknown>;
    const socials = Array.isArray(i.socials) ? (i.socials as { platform: string; followers?: number }[]) : [];
    const platforms = [...new Set(socials.map((s) => s.platform).filter((p) => p === "youtube" || p === "instagram"))].sort();
    const cats = Array.isArray(i.categories) ? (i.categories as { id: string }[]).map((c) => c.id) : [];
    return {
      slug: h.slug, name: h.name, handle: h.handle ?? null, avatar: h.avatar ?? null, presence: h.presence ?? "offline",
      followers: socials.reduce((n, s) => n + (Number(s.followers) || 0), 0), platforms, topics: cats, ratePaise: i.ratePaise ?? h.ratePaise ?? 0,
      videoKycVerified: false, space: i.womenOnly === true ? "women" : null, callerLevel: "everyone", channelVerified: socials.length > 0,
      ...(h.callState ? { callState: h.callState, queue: h.queue } : {}),
    } as Record<string, unknown>;
  });
  return { online: hosts.filter((h) => h.presence !== "offline"), offline: hosts.filter((h) => h.presence === "offline") };
}
