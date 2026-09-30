// [SAATHUM-PREETI-1 2026-09-30] Card resolution + the single "where does this event sit right now" rule Preeti
// uses. Mirrors routes/saathum_checkout.ts computeBookable (stream state first, then bookability) so what
// she says can never disagree with what the /book/<id> page lets a buyer do.
import type { Env } from "../../types";
import { BRAND } from "../brand";
import { bookability, eventWindow, scheduleState, toMs } from "../listing_schedule";
import { computeStreamState } from "../saathum_stream_state";
import type { BrandRuntime, PreetiCard } from "./contracts";

export interface EventRow {
  id: string; title: string; description: string | null; category: string | null; category_label: string | null;
  kind: string; status: string; starts_at: number | null; duration_min: number | null; price: number | null;
  capacity: number | null; expires_at: number | null; cover_media: string | null; attrs: string | null;
  temple_name: string | null; temple_place: string | null; location: string | null;
  video_id: string | null; video_ended_at: number | null;
}

export const EVENT_SELECT = `SELECT l.id, l.title, l.description, l.category, c.label AS category_label, l.kind, l.status,
    l.starts_at, l.duration_min, l.price, l.capacity, l.expires_at, l.cover_media, l.attrs, l.location,
    t.name AS temple_name, t.place AS temple_place,
    v.youtube_video_id AS video_id, v.ended_at AS video_ended_at
  FROM listings l
  LEFT JOIN listing_categories c ON c.id=l.category
  LEFT JOIN saathum_temples t ON t.id=l.temple_id
  LEFT JOIN event_videos v ON v.listing_id=l.id`;

export interface EventState {
  state: "upcoming" | "starting" | "live" | "ended" | "cancelled" | "unavailable";
  live_now: boolean; booking_open: boolean; booking_note: string | null;
}

/** Same precedence as computeBookable: ended stream wins, a live stream keeps booking open, else the schedule. */
export function eventState(row: EventRow, now = Date.now(), seatsTaken = 0): EventState {
  if (row.kind !== "live_event") return { state: "unavailable", live_now: false, booking_open: false, booking_note: "not an event" };
  const start = toMs(row.starts_at);
  const stream = computeStreamState({
    hasVideo: !!row.video_id, endedAt: row.video_ended_at ?? null, listingStatus: row.status,
    startsAt: start, durationMin: row.duration_min, now,
  });
  const sched = scheduleState(row, now);
  if (row.status === "cancelled") return { state: "cancelled", live_now: false, booking_open: false, booking_note: "This event was cancelled." };
  if (stream === "ended") return { state: "ended", live_now: false, booking_open: false, booking_note: "This event has ended; bookings are closed." };
  const live = stream === "live" || row.status === "live";
  if (!live) {
    const b = bookability(row, now);
    if (!b.ok) return { state: sched === "ended" ? "ended" : sched === "starting" ? "starting" : "unavailable", live_now: false, booking_open: false, booking_note: b.message };
  }
  if (row.capacity != null && seatsTaken >= row.capacity) {
    return { state: live ? "live" : (sched === "starting" ? "starting" : "upcoming"), live_now: live, booking_open: false, booking_note: "Sold out." };
  }
  return { state: live ? "live" : (sched === "starting" ? "starting" : "upcoming"), live_now: live, booking_open: true, booking_note: null };
}

export async function seatsTaken(env: Env, listingId: string): Promise<number> {
  try {
    const r = await env.DB_META.prepare(
      `SELECT COUNT(*) n FROM commercial_entitlements WHERE listing_id=?1 AND role IN ('viewer','buyer') AND state IN ('reserved','held','active','consumed')`,
    ).bind(listingId).first<{ n: number }>();
    return Number(r?.n ?? 0);
  } catch { return 0; }
}

export async function loadEventRow(env: Env, id: string): Promise<EventRow | null> {
  return await env.DB_META.prepare(`${EVENT_SELECT} WHERE l.id=?1`).bind(id).first<EventRow>().catch(() => null);
}

function absUrl(brand: BrandRuntime, u: string): string {
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return brand.site + u;
  return `${BRAND.mediaOrigin}/${u}`;
}

export function eventImage(brand: BrandRuntime, row: Pick<EventRow, "cover_media" | "attrs">): string | null {
  try {
    const a = row.attrs ? JSON.parse(row.attrs) : null;
    const pu = a?.poster?.url;
    if (typeof pu === "string" && pu && (a?.poster?.status === "approved" || a?.poster?.status === "draft")) return absUrl(brand, pu);
  } catch { /* fall to cover */ }
  try {
    const arr = row.cover_media ? JSON.parse(row.cover_media) : [];
    if (Array.isArray(arr)) for (const m of arr) {
      const u = m?.url ?? m?.r2_key;
      if (typeof u === "string" && u) return absUrl(brand, u);
    }
  } catch { /* none */ }
  return null;
}

export const eventReadMore = (brand: BrandRuntime, id: string) => `${brand.site}/book/${encodeURIComponent(id)}`;

export async function resolveEventCard(env: Env, brand: BrandRuntime, id: string): Promise<PreetiCard | null> {
  const row = await loadEventRow(env, id);
  if (!row || row.kind !== "live_event" || !["published", "live", "completed"].includes(String(row.status))) return null;
  const st = eventState(row, Date.now(), row.capacity != null ? await seatsTaken(env, id) : 0);
  if (st.state === "cancelled" || st.state === "unavailable") return null;
  const url = eventReadMore(brand, row.id);
  return {
    type: "event", id: row.id, title: row.title, image: eventImage(brand, row),
    starts_at_ms: toMs(row.starts_at), price_rupees: row.price != null ? Number(row.price) : null,
    live_now: st.live_now, booking_open: st.booking_open, read_more_url: url, book_url: `${url}/checkout`,
  };
}

// ---- articles (ritual guides) — the web owns the list; the worker reads the public llms-rituals.txt ----
let ritualCache: { at: number; site: string; items: { slug: string; title: string; desc: string }[] } | null = null;
export async function ritualIndex(brand: BrandRuntime): Promise<{ slug: string; title: string; desc: string }[]> {
  if (ritualCache && ritualCache.site === brand.site && Date.now() - ritualCache.at < 10 * 60_000) return ritualCache.items;
  const items: { slug: string; title: string; desc: string }[] = [];
  try {
    const r = await fetch(`${brand.site}/llms-rituals.txt`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      for (const line of (await r.text()).split("\n")) {
        const m = /^- \[(.+?)\]\((\S+?)\)(?::\s*(.*))?$/.exec(line.trim());
        if (!m) continue;
        const slug = m[2].replace(/\/+$/, "").split("/").pop() ?? "";
        if (slug) items.push({ slug, title: m[1], desc: (m[3] ?? "").slice(0, 140) });
      }
    }
  } catch { /* stale cache below */ }
  if (items.length) ritualCache = { at: Date.now(), site: brand.site, items };
  return items.length ? items : ritualCache?.items ?? [];
}

export async function resolveArticleCard(brand: BrandRuntime, slug: string): Promise<PreetiCard | null> {
  const it = (await ritualIndex(brand)).find((x) => x.slug === slug);
  if (!it) return null;
  return { type: "article", slug, title: it.title, image: `${brand.site}/assets/saathum-rituals/${encodeURIComponent(slug)}.png`, url: `${brand.site}/rituals/${encodeURIComponent(slug)}/` };
}

export { eventWindow };
