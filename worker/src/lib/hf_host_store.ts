// [HF-HOST-PLATFORM-1] Row <-> JSON mapping + D1 access for HF hosts. Shared with the workflow/admin agents; keep exports stable.
import type { Env } from "../types";
import { makeSlug } from "./hf_options";
import { introStatusOf, INTRO_MEDIA_KIND } from "./hf_intro";

export interface HostRow {
  uid: string; slug: string | null; status: string;
  display_name: string | null; about: string | null; tagline: string | null; quote: string | null; about_polished: string | null;
  languages_json: string; style: string | null; topics_json: string; conversation_lang: string | null;
  price_per_min: number; hours_json: string; health_consent: number; women_lane: number; lgbtq_lane: number; lgbtq_public: number;
  avatar_id: string | null; voice_sample_r2: string | null; voice_seconds: number | null; voice_consent_at: number | null;
  // [HF-VOICE-INTRO-1] host's own recorded introduction (private copy in VERIFICATION until approved)
  intro_mime: string | null; intro_status: string | null; intro_transcript: string | null; intro_flags_json: string | null; intro_uploaded_at: number | null;
  gen_attempts: number; agreements_at: number | null; review_note: string | null; reviewed_by: string | null; reviewed_at: number | null;
  submitted_at: number | null; live_at: number | null; created_at: number; updated_at: number;
}
export interface MediaRow { id: string; uid: string; kind: string; r2_key: string; caption: string | null; transcript_json: string | null; sort: number; status: string; job_id: string | null; created_at: number }

export const mediaUrl = (env: Env, key: string): string => `${env.BLOSSOM_BASE_URL}/${key}`;
const parse = <T>(s: string | null | undefined, fb: T): T => { try { return s ? (JSON.parse(s) as T) : fb; } catch { return fb; } };

export async function avatarUrlFor(env: Env, avatarId: string | null): Promise<string | null> {
  if (!avatarId) return null;
  const r = await env.DB_META.prepare("SELECT image_key FROM hf_avatars WHERE id=?1").bind(avatarId).first<{ image_key: string }>().catch(() => null);
  return r ? mediaUrl(env, r.image_key) : null;
}

export function hostToJson(env: Env, r: HostRow, avatarUrl: string | null = null) {
  return {
    uid: r.uid, slug: r.slug, status: r.status, displayName: r.display_name, about: r.about, tagline: r.tagline, quote: r.quote,
    aboutPolished: r.about_polished, languages: parse<string[]>(r.languages_json, []), style: r.style, topics: parse<string[]>(r.topics_json, []),
    conversationLang: r.conversation_lang, pricePerMin: r.price_per_min, hours: parse<Record<string, unknown>>(r.hours_json, {}),
    healthConsent: r.health_consent === 1, womenLane: r.women_lane === 1, lgbtqLane: r.lgbtq_lane === 1, lgbtqPublic: r.lgbtq_public === 1,
    avatarId: r.avatar_id, avatarUrl,
    voice: {
      seconds: r.intro_status ? r.voice_seconds : null, mime: r.intro_status ? r.intro_mime : null,
      status: introStatusOf(r.intro_status), uploadedAt: r.intro_status ? r.intro_uploaded_at : null,
    }, genAttempts: r.gen_attempts, agreementsAt: r.agreements_at, reviewNote: r.review_note, liveAt: r.live_at,
  };
}
export type HostJson = ReturnType<typeof hostToJson>;

export function mediaToJson(env: Env, m: MediaRow) {
  const t = parse<{ speaker: "host" | "caller"; text: string }[] | null>(m.transcript_json, null);
  return { id: m.id, kind: m.kind, url: mediaUrl(env, m.r2_key), caption: m.kind === INTRO_MEDIA_KIND ? null : m.caption, ...(t ? { transcript: t } : {}), sort: m.sort };
}

export async function getHost(env: Env, uid: string): Promise<HostRow | null> {
  return env.DB_META.prepare("SELECT * FROM hf_hosts WHERE uid=?1").bind(uid).first<HostRow>();
}

export async function listMedia(env: Env, uid: string): Promise<MediaRow[]> {
  const r = await env.DB_META.prepare("SELECT * FROM hf_host_media WHERE uid=?1 AND status='active' ORDER BY CASE kind WHEN 'profile' THEN 0 WHEN 'gallery' THEN 1 ELSE 2 END, sort, created_at").bind(uid).all<MediaRow>();
  return r.results ?? [];
}

/** Column -> value patch (snake_case column names; values already validated/serialised). Creates the row on first call. */
export type HostPatch = Partial<Omit<HostRow, "uid" | "created_at" | "updated_at">>;
const COLS = new Set(["slug", "status", "display_name", "about", "tagline", "quote", "about_polished", "languages_json", "style", "topics_json", "conversation_lang",
  "price_per_min", "hours_json", "health_consent", "women_lane", "lgbtq_lane", "lgbtq_public", "avatar_id", "voice_sample_r2", "voice_seconds", "voice_consent_at",
  "intro_mime", "intro_status", "intro_transcript", "intro_flags_json", "intro_uploaded_at",
  "gen_attempts", "agreements_at", "review_note", "reviewed_by", "reviewed_at", "submitted_at", "live_at"]);

export async function upsertHost(env: Env, uid: string, patch: HostPatch): Promise<HostRow> {
  const now = Date.now();
  const keys = Object.keys(patch).filter((k) => COLS.has(k) && k !== "slug");
  const existing = await getHost(env, uid);
  if (!existing) {
    await env.DB_META.prepare("INSERT OR IGNORE INTO hf_hosts (uid, created_at, updated_at) VALUES (?1,?2,?2)").bind(uid, now).run();
  }
  if (keys.length) {
    const sets = keys.map((k, i) => `${k}=?${i + 2}`).join(", ");
    const vals = keys.map((k) => (patch as Record<string, unknown>)[k] ?? null);
    await env.DB_META.prepare(`UPDATE hf_hosts SET ${sets}, updated_at=?${keys.length + 2} WHERE uid=?1`).bind(uid, ...vals, now).run();
  }
  const cur = (await getHost(env, uid))!;
  if (!cur.slug && cur.display_name) await ensureSlug(env, uid, cur.display_name);
  return (await getHost(env, uid))!;
}

/** Assigns `<first-name>-<4 random>` once (unique); never changes an existing slug. */
export async function ensureSlug(env: Env, uid: string, displayName: string): Promise<string | null> {
  for (let i = 0; i < 8; i++) {
    const slug = makeSlug(displayName);
    try {
      const r = await env.DB_META.prepare("UPDATE hf_hosts SET slug=?2 WHERE uid=?1 AND slug IS NULL").bind(uid, slug).run();
      if (r.meta?.changes) return slug;
      const cur = await getHost(env, uid);
      if (cur?.slug) return cur.slug;
    } catch { /* UNIQUE collision: retry with a new suffix */ }
  }
  return null;
}
