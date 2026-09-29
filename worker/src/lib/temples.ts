// [SAATHUM-TEMPLE-FIELD-1 2026-09-29] OWNER REQUEST: "Temple on each event".
// Reusable temple directory (D1 table saathum_temples, migration
// 2026-09-29-saathum-temples.sql) + a nullable listings.temple_id. Pure rules and the
// small D1 helpers live here; the admin routes are in routes/admin2_events.ts and the
// public reads (event page card, checkout config) call templeForListing().
//
// NOTE FOR AI: every reader of the temple is best-effort (try/catch -> null). A worker
// deployed before the migration must keep serving events, never 500 on a missing table.
import type { Env } from "../types";

export const TEMPLE_LIMITS = { nameMin: 2, nameMax: 80, placeMin: 2, placeMax: 80 } as const;

export type Temple = { id: string; name: string; place: string; region: string | null; created_at: number };
/** What customers see: the temple's name and where it is. */
export type PublicTemple = { id: string; name: string; place: string };

const clean = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

export function normalizeTempleInput(body: Record<string, unknown>): { name: string; place: string } | { error: string; field: "name" | "place" } {
  const name = clean(body.name);
  const place = clean(body.place);
  if (name.length < TEMPLE_LIMITS.nameMin || name.length > TEMPLE_LIMITS.nameMax) {
    return { error: `Temple name must be ${TEMPLE_LIMITS.nameMin}-${TEMPLE_LIMITS.nameMax} characters.`, field: "name" };
  }
  if (place.length < TEMPLE_LIMITS.placeMin || place.length > TEMPLE_LIMITS.placeMax) {
    return { error: `Place must be ${TEMPLE_LIMITS.placeMin}-${TEMPLE_LIMITS.placeMax} characters.`, field: "place" };
  }
  return { name, place };
}

/** "Kunjapuri Devi Temple, Rishikesh" — the one display form used everywhere. */
export function templeLabel(t: { name: string; place: string }): string {
  return `${t.name}, ${t.place}`;
}

export async function listTemples(env: Env): Promise<Temple[]> {
  const r = await env.DB_META.prepare(
    "SELECT id, name, place, region, created_at FROM saathum_temples ORDER BY name COLLATE NOCASE ASC, place COLLATE NOCASE ASC LIMIT 500",
  ).all<Temple>();
  return r.results ?? [];
}

/** Insert a temple, or return the existing one when name+place match case-insensitively. */
export async function createTemple(env: Env, input: { name: string; place: string }, region: string | null = null): Promise<{ temple: Temple; created: boolean }> {
  const dup = await env.DB_META.prepare(
    "SELECT id, name, place, region, created_at FROM saathum_temples WHERE lower(name)=lower(?1) AND lower(place)=lower(?2)",
  ).bind(input.name, input.place).first<Temple>();
  if (dup) return { temple: dup, created: false };
  const temple: Temple = { id: `temple_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, name: input.name, place: input.place, region, created_at: Date.now() };
  await env.DB_META.prepare("INSERT INTO saathum_temples (id, name, place, region, created_at) VALUES (?1,?2,?3,?4,?5)")
    .bind(temple.id, temple.name, temple.place, temple.region, temple.created_at).run();
  return { temple, created: true };
}

export async function templeExists(env: Env, id: string): Promise<boolean> {
  if (!id || id.length > 100) return false;
  return !!(await env.DB_META.prepare("SELECT 1 FROM saathum_temples WHERE id=?1").bind(id).first());
}

/**
 * Parse the `temple_id` an admin sends: undefined = not sent (leave alone),
 * null = clear it, string = set it (validated by the caller with templeExists()).
 */
export function parseTempleIdInput(body: Record<string, unknown>): { present: false } | { present: true; value: string | null } | { error: string } {
  if (!Object.prototype.hasOwnProperty.call(body, "temple_id")) return { present: false };
  const v = body.temple_id;
  if (v === null || v === "") return { present: true, value: null };
  if (typeof v !== "string" || v.length > 100) return { error: "Pick a temple from the list." };
  return { present: true, value: v };
}

/** The temple set on a listing (public shape), or null. Never throws. */
export async function templeForListing(env: Env, listingId: string): Promise<PublicTemple | null> {
  try {
    const row = await env.DB_META.prepare(
      `SELECT t.id, t.name, t.place FROM listings l JOIN saathum_temples t ON t.id=l.temple_id WHERE l.id=?1`,
    ).bind(listingId).first<PublicTemple>();
    return row ? { id: row.id, name: row.name, place: row.place } : null;
  } catch { return null; }
}

/** Set (or clear) listings.temple_id. Not part of the reviewed content hash. */
export async function setListingTemple(env: Env, listingId: string, templeId: string | null): Promise<void> {
  await env.DB_META.prepare("UPDATE listings SET temple_id=?2 WHERE id=?1").bind(listingId, templeId).run();
}
