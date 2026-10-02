// [AUMFE-CONSULT-FOUNDATION-1] Shared consultant reads. Lanes add their OWN query helpers in their own files;
// only add here what two or more lanes need (append, never reorder).
import type { Env } from "../../types";
import { metaDb } from "../../db/shard";
import { priceFor } from "./pricing";
import type { ConsultantCard, ConsultantDetail, ConsultantStatus, Discipline } from "./types";

export interface ConsultantRow {
  id: string; uid: string | null; slug: string; name: string; disciplines_json: string; photo_url: string; photo_hero_url: string | null;
  tagline: string | null; bio: string | null; lineage: string | null; city: string | null; languages_json: string; years: number | null;
  rate_rupees: number; rate_floor: number; rate_ceil: number; slot_minutes: number; buffer_minutes: number; status: ConsultantStatus;
  strikes: number; is_seed: number; sort_order: number; created_at: number; updated_at: number;
}

const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

export async function consultantBySlug(env: Env, slug: string): Promise<ConsultantRow | null> {
  return (await metaDb(env).prepare("SELECT * FROM consultants WHERE slug = ?").bind(slug).first<ConsultantRow>()) ?? null;
}
export async function consultantById(env: Env, id: string): Promise<ConsultantRow | null> {
  return (await metaDb(env).prepare("SELECT * FROM consultants WHERE id = ?").bind(id).first<ConsultantRow>()) ?? null;
}
export async function consultantByUid(env: Env, uid: string): Promise<ConsultantRow | null> {
  return (await metaDb(env).prepare("SELECT * FROM consultants WHERE uid = ?").bind(uid).first<ConsultantRow>()) ?? null;
}

export function toCard(r: ConsultantRow, extra: { rating_avg: number | null; rating_count: number; next_free_ms: number | null }): ConsultantCard {
  return {
    id: r.id, slug: r.slug, name: r.name, disciplines: parse<Discipline[]>(r.disciplines_json, []),
    photo_url: r.photo_url, photo_hero_url: r.photo_hero_url || r.photo_url, years: r.years, languages: parse<string[]>(r.languages_json, []),
    city: r.city, tagline: r.tagline, slot_minutes: r.slot_minutes, price: priceFor(r.rate_rupees), status: r.status, ...extra,
  };
}
export function toDetail(r: ConsultantRow, extra: { rating_avg: number | null; rating_count: number; next_free_ms: number | null; covers?: string[] }): ConsultantDetail {
  return { ...toCard(r, extra), bio: r.bio, lineage: r.lineage, covers: extra.covers ?? [] };
}

/** Approved, non-seed (unless includeSeed) rating summary. */
export async function ratingFor(env: Env, consultantId: string, includeSeed: boolean): Promise<{ rating_avg: number | null; rating_count: number }> {
  const row = await metaDb(env).prepare(
    `SELECT AVG(stars) AS a, COUNT(*) AS n FROM consult_reviews WHERE consultant_id = ? AND status = 'approved' ${includeSeed ? "" : "AND seed = 0"}`,
  ).bind(consultantId).first<{ a: number | null; n: number }>();
  const n = Number(row?.n || 0);
  return { rating_avg: n ? Math.round(Number(row?.a) * 10) / 10 : null, rating_count: n };
}

export const newId = (prefix: string, hexLen = 20): string => {
  const b = new Uint8Array(Math.ceil(hexLen / 2)); crypto.getRandomValues(b);
  return prefix + [...b].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, hexLen);
};
export const bookingRefOf = (id: string): string => `AFC-${id.replace(/^cb_/, "").slice(0, 8).toUpperCase()}`;
