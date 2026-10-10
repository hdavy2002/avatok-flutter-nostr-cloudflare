// [HF-NATIVE-S2] Pure parsing + SQL building for GET /api/hf/hosts (native app host list). No env / network here.
import { TOPIC_SLUGS, LANGUAGE_CODES, LANGUAGES, PRICE_MIN, PRICE_MAX } from "./hf_options";
import { parseLane, type Lane } from "./hf_lanes";

export const LIST_DEFAULT_LIMIT = 24;
export const LIST_MAX_LIMIT = 48;
export const LIST_MAX_OFFSET = 10_000;
export const SORTS = ["online_first", "price_low", "rating"] as const;
export type HostSort = (typeof SORTS)[number];

export interface HostListQuery {
  topics: string[]; langs: string[]; minPrice: number | null; maxPrice: number | null;
  online: boolean; lane: Lane | null; sort: HostSort; limit: number; offset: number;
}
export type ParsedHostList = { ok: true; q: HostListQuery } | { ok: false; status: 400; error: string };

const csv = (v: string | null): string[] => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 64);
const num = (v: string | null): number | null => {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null; // non-numeric = parameter absent
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const LANG_NAMES = new Map(LANGUAGES.map((l) => [l.toLowerCase(), l]));

/** Validates and clamps every query parameter. Unknown enum-like values are a 400 (never silently widen a filter). */
export function parseHostList(sp: URLSearchParams): ParsedHostList {
  const topics = [...new Set(csv(sp.get("topic")))];
  for (const t of topics) if (!TOPIC_SLUGS.has(t)) return { ok: false, status: 400, error: "bad_topic" };
  const langs: string[] = [];
  for (const raw of csv(sp.get("lang"))) {
    const l = raw.toLowerCase();
    const name = LANGUAGE_CODES[l] ?? LANG_NAMES.get(l);
    if (!name) return { ok: false, status: 400, error: "bad_lang" };
    if (!langs.includes(name)) langs.push(name);
  }
  const laneRaw = sp.get("lane");
  const lane = parseLane(laneRaw);
  if (laneRaw && !lane) return { ok: false, status: 400, error: "bad_lane" };
  const sortRaw = sp.get("sort");
  if (sortRaw && !(SORTS as readonly string[]).includes(sortRaw)) return { ok: false, status: 400, error: "bad_sort" };
  const mx = num(sp.get("maxPrice")), mn = num(sp.get("minPrice"));
  const lim = num(sp.get("limit")), off = num(sp.get("offset"));
  return {
    ok: true,
    q: {
      topics, langs,
      maxPrice: mx == null ? null : clamp(Math.floor(mx), PRICE_MIN, PRICE_MAX),
      minPrice: mn == null ? null : clamp(Math.floor(mn), PRICE_MIN, PRICE_MAX),
      online: sp.get("online") === "1" || sp.get("online") === "true",
      lane,
      sort: (sortRaw as HostSort) || "online_first",
      limit: lim == null ? LIST_DEFAULT_LIMIT : clamp(Math.floor(lim), 1, LIST_MAX_LIMIT),
      offset: off == null ? 0 : clamp(Math.floor(off), 0, LIST_MAX_OFFSET),
    },
  };
}

/** Canonical cache key (stable param order, validated values only), never includes lane (lane responses are not cached). */
export function listCacheKey(q: HostListQuery): string {
  const p = new URLSearchParams();
  if (q.topics.length) p.set("topic", [...q.topics].sort().join(","));
  if (q.langs.length) p.set("lang", [...q.langs].sort().join(","));
  if (q.minPrice != null) p.set("minPrice", String(q.minPrice));
  if (q.maxPrice != null) p.set("maxPrice", String(q.maxPrice));
  if (q.online) p.set("online", "1");
  p.set("sort", q.sort); p.set("limit", String(q.limit)); p.set("offset", String(q.offset));
  return p.toString();
}

const PRESENCE_RANK = "CASE h.presence WHEN 'online' THEN 0 WHEN 'busy' THEN 1 ELSE 2 END";
// Rating = average of approved stars, 1 decimal (same rounding as the card); unrated hosts sort last.
const RATING_JOIN = `LEFT JOIN (SELECT host_uid, ROUND(AVG(stars), 1) AS avg_stars, COUNT(*) AS n_stars FROM hf_reviews WHERE status='approved' GROUP BY host_uid) rv ON rv.host_uid = h.uid`;
const RATING_ORDER = "(rv.avg_stars IS NULL), rv.avg_stars DESC, rv.n_stars DESC";
const ORDER: Record<HostSort, string> = {
  online_first: `${PRESENCE_RANK}, ${RATING_ORDER}, h.live_at DESC, h.uid`,
  price_low: `h.price_per_min ASC, ${PRESENCE_RANK}, ${RATING_ORDER}, h.live_at DESC, h.uid`,
  rating: `${RATING_ORDER}, ${PRESENCE_RANK}, h.live_at DESC, h.uid`,
};

const marks = (n: number, from: number) => Array.from({ length: n }, (_, i) => `?${from + i}`).join(",");

/** WHERE clause + bind values (published, approved = status 'live' only). */
export function buildWhere(q: HostListQuery): { where: string; binds: (string | number)[] } {
  const binds: (string | number)[] = [];
  const w = ["h.status='live'", "h.slug IS NOT NULL"];
  const add = (v: string | number) => { binds.push(v); return binds.length; };
  if (q.lane) w.push(q.lane === "women" ? "h.women_lane=1" : "h.lgbtq_lane=1");
  if (q.topics.length) {
    const from = binds.length + 1; binds.push(...q.topics);
    w.push(`EXISTS (SELECT 1 FROM json_each(h.topics_json) t WHERE t.value IN (${marks(q.topics.length, from)}))`);
  }
  if (q.langs.length) {
    const from = binds.length + 1; binds.push(...q.langs);
    w.push(`EXISTS (SELECT 1 FROM json_each(h.languages_json) l WHERE l.value IN (${marks(q.langs.length, from)}))`);
  }
  if (q.maxPrice != null) w.push(`h.price_per_min <= ?${add(q.maxPrice)}`);
  if (q.minPrice != null) w.push(`h.price_per_min >= ?${add(q.minPrice)}`);
  if (q.online) w.push("h.presence='online'");
  return { where: w.join(" AND "), binds };
}

export function buildListSql(sel: string, q: HostListQuery): { sql: string; binds: (string | number)[]; countSql: string; countBinds: (string | number)[] } {
  const { where, binds } = buildWhere(q);
  const n = binds.length;
  return {
    // sel already carries `FROM hf_hosts h LEFT JOIN hf_avatars a ...`; the ratings join is appended before WHERE.
    sql: `${sel} ${RATING_JOIN} WHERE ${where} ORDER BY ${ORDER[q.sort]} LIMIT ?${n + 1} OFFSET ?${n + 2}`,
    binds: [...binds, q.limit, q.offset],
    countSql: `SELECT COUNT(*) AS c FROM hf_hosts h WHERE ${where}`,
    countBinds: binds,
  };
}
