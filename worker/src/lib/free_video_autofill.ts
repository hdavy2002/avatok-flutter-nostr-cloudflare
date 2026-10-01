// [SAATHUM-FREEVIDEOS-AUTOFILL-1 2026-10-01] Owner request: paste a YouTube link in the
// admin "New free video" form and the form fills itself — the video's own title and
// description are pulled from YouTube, then AI rewrites them into a UNIQUE title and
// description in the site's voice, and picks the category.
//
// Source of the original text: YouTube Data API v3 (snippet) when YOUTUBE_API_KEY is set,
// else YouTube oEmbed (title + channel only). AI: avaReason + the same input/output guards
// the listing ad-hook uses. Never throws: on any AI failure the cleaned YouTube text comes
// back with source "youtube" so the admin still gets a filled form to edit.
import { BRAND } from "./brand";
import type { Env } from "../types";
import { avaReason } from "./ava_reason";
import { guardInput, guardOutput } from "./ai_gate";
import { track, trackException } from "../hooks";
import { readConfig } from "../routes/config";

export const AUTOFILL_CATEGORIES = ["satsang", "meditation", "sermon", "bhajan", "aarti", "festival"] as const;
export type AutofillCategory = (typeof AUTOFILL_CATEGORIES)[number];

export interface YoutubeMeta { title: string; description: string; channel: string; tags: string[] }
export interface AutofillResult {
  title: string;
  description: string;
  category: AutofillCategory | null;
  source: "ai" | "youtube";
  original: { title: string; channel: string };
}

const TITLE_MAX = 80;
const DESC_MAX = 450;

/** Strip links, hashtags, emoji, timestamps and runs of whitespace from YouTube text. */
export function cleanYoutubeText(s: string): string {
  return String(s ?? "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, " ")
    .replace(/(^|\s)@[\p{L}\p{N}_.]+/gu, " ")
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, " ")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/[|•▶►✅⭐]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, "") + (at > max * 0.6 && cut[at] === "." ? "." : "…");
}

/** Guess a category from words in the text (used when AI is off or returns none). */
export function guessCategory(text: string): AutofillCategory | null {
  const t = text.toLowerCase();
  if (/\b(aarti|arti)\b/.test(t)) return "aarti";
  if (/\b(bhajan|kirtan|chalisa|naam jap|jaap|sankirtan)\b/.test(t)) return "bhajan";
  if (/\b(meditation|dhyan|dhyana|yoga nidra|pranayam)\b/.test(t)) return "meditation";
  if (/\b(satsang|satsangh)\b/.test(t)) return "satsang";
  if (/\b(pravachan|katha|discourse|sermon|updesh|ekantik)\b/.test(t)) return "sermon";
  if (/\b(diwali|holi|navratri|janmashtami|shivratri|festival|utsav|mahotsav)\b/.test(t)) return "festival";
  return null;
}

export async function fetchYoutubeMeta(env: Env, videoId: string, fetchFn: typeof fetch = fetch): Promise<YoutubeMeta | null> {
  const key = (env.YOUTUBE_API_KEY ?? "").trim();
  if (key) {
    try {
      const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(key)}`;
      const r = await fetchFn(url, { headers: { accept: "application/json" } });
      if (r.ok) {
        const j: any = await r.json();
        const sn = j?.items?.[0]?.snippet;
        if (sn) return { title: String(sn.title ?? ""), description: String(sn.description ?? ""), channel: String(sn.channelTitle ?? ""), tags: Array.isArray(sn.tags) ? sn.tags.map(String).slice(0, 15) : [] };
        return null; // no such video
      }
    } catch { /* fall through to oEmbed */ }
  }
  try {
    const r = await fetchFn(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`);
    if (!r.ok) return null;
    const j: any = await r.json();
    return { title: String(j?.title ?? ""), description: "", channel: String(j?.author_name ?? ""), tags: [] };
  } catch {
    return null;
  }
}

function prompt(meta: YoutubeMeta): { system: string; user: string } {
  const system = [
    `You write listings for ${BRAND.nameCompact}, an Indian devotional site where people watch satsang, bhajan, aarti, pravachan and meditation videos for free.`,
    "Rewrite the YouTube video's title and description into ORIGINAL text for our page — do not copy phrases; say it in your own words.",
    `Title: ${TITLE_MAX} characters max, warm and clear, names the deity, saint, ritual or theme. Description: 2 to 3 short sentences, ${DESC_MAX} characters max, tells a devotee what they will see and why to watch.`,
    "Rules: English (common Hindi words like satsang, bhajan, Maa, ashirwad are fine); never mention YouTube, the channel, subscribe, like, share or links; no hashtags, emojis, prices, dates, phone numbers; no promises of results, cures or miracles; only use facts present in the source.",
    `Pick the category from exactly one of: ${AUTOFILL_CATEGORIES.join(", ")}.`,
    'Reply with JSON only: {"title":"…","description":"…","category":"…"}',
  ].join(" ");
  const user = [
    `YouTube title: ${cleanYoutubeText(meta.title).slice(0, 200)}`,
    `YouTube description: ${cleanYoutubeText(meta.description).slice(0, 1500)}`,
    meta.tags.length ? `Tags: ${meta.tags.join(", ").slice(0, 300)}` : "",
  ].filter(Boolean).join("\n");
  return { system, user };
}

/** Pull the first {...} JSON object out of a model reply. */
export function parseAutofillJson(raw: string): { title?: string; description?: string; category?: string } | null {
  const s = String(raw ?? "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(s.slice(a, b + 1));
    return j && typeof j === "object" ? j : null;
  } catch { return null; }
}

function asCategory(v: unknown): AutofillCategory | null {
  const c = String(v ?? "").trim().toLowerCase();
  return (AUTOFILL_CATEGORIES as readonly string[]).includes(c) ? (c as AutofillCategory) : null;
}

/** The fallback when AI is off/fails: the cleaned YouTube text, clipped to our limits. */
export function fallbackFromYoutube(meta: YoutubeMeta): AutofillResult {
  const title = clip(cleanYoutubeText(meta.title), TITLE_MAX);
  const firstPara = cleanYoutubeText((meta.description.split(/\n\s*\n/)[0] ?? meta.description));
  const description = clip(firstPara, DESC_MAX);
  return {
    title, description,
    category: guessCategory(`${meta.title} ${meta.description} ${meta.tags.join(" ")}`),
    source: "youtube",
    original: { title: meta.title, channel: meta.channel },
  };
}

export async function autofillFromYoutube(env: Env, uid: string, meta: YoutubeMeta): Promise<AutofillResult> {
  const floor = fallbackFromYoutube(meta);
  let status = "ok";
  try {
    const cfg = await readConfig(env);
    if (!cfg.aiEnabled) { status = "disabled"; return floor; }
    const { system, user } = prompt(meta);
    const gate = await guardInput(env, user);
    if (!gate.ok) { status = "input_blocked"; return floor; }
    const raw = await avaReason(env, {
      role: "listing", capability: "free_video_autofill", trigger: "admin_free_video_autofill",
      feature: "listing_ad_hook", uid, system, user, temperature: 0.7, maxTokens: 500, timeoutMs: 15000,
    });
    const j = parseAutofillJson(String(raw ?? ""));
    const title = clip(cleanYoutubeText(String(j?.title ?? "")), TITLE_MAX);
    const description = clip(cleanYoutubeText(String(j?.description ?? "")), DESC_MAX);
    if (title.length < 3 || description.length < 20) { status = raw ? "unparseable" : "empty"; return floor; }
    const out = await guardOutput(env, `${title}\n${description}`);
    if (!out.ok) { status = "output_blocked"; return floor; }
    return { title, description, category: asCategory(j?.category) ?? floor.category, source: "ai", original: floor.original };
  } catch (e) {
    status = "error";
    try { await trackException(env, e, { uid, handled: true, app_name: "free_videos", extra: { feature: "free_video_autofill" } }); } catch { /* best-effort */ }
    return floor;
  } finally {
    try { void track(env, uid, "free_video_autofill", "free_videos", { ai_status: status }); } catch { /* best-effort */ }
  }
}
