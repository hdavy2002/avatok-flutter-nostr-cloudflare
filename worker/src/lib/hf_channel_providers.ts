// [HF-WIRE-3] Channel look-ups for the Reels app (HF-REEL-26).
//   YouTube   -> official YouTube Data API v3 (secret YOUTUBE_API_KEY): channels.list part=snippet,statistics, forHandle / id.
//   Instagram -> treg gateway (secret TREG_API_KEY, header X-Treg-Token), TikHub with ScrapeCreators fallback on provider failure.
//                Parsers accept ScrapeCreators shapes (Specs/HF-TREG-JEV-RESEARCH.md §2) and TikHub data.data.user.
// Both return the same ChannelLookup. A missing secret throws ProviderError('provider_not_configured'); a provider that is down,
// rate-limited or blocked throws ProviderError('provider_unavailable'). Secrets are never logged, never echoed in an error message,
// and a URL carrying a key is never put into an error. Ownership checks must never use a cache: no cache parameter is sent.
import type { Env } from "../types";

export type ChannelPlatform = "instagram" | "youtube";

export interface ChannelLookup {
  exists: boolean;
  platformUserId: string | null;
  handle: string;
  followers: number;
  /** [HF-CREATOR-SPACES-1] Total channel views (YouTube statistics.viewCount). Undefined for Instagram: it has no total views, so only followers are checked there. */
  views?: number;
  /** Bio (Instagram) or channel description (YouTube); "" when the account has none or it is not readable. */
  bio: string;
  isPrivate: boolean;
  /** YouTube channel with the subscriber count switched off. */
  countHidden: boolean;
  url: string;
  /** [HF-WIRE-22] Public name and picture, when the provider returns them (used for invite cards). */
  displayName?: string;
  avatarUrl?: string | null;
}

export type ProviderErrorCode = "provider_not_configured" | "provider_unavailable" | "bad_handle" | "token_invalid";

export class ProviderError extends Error {
  code: ProviderErrorCode;
  constructor(code: ProviderErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "ProviderError";
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export const PROVIDER_TIMEOUT_MS = 8000;

async function timedFetch(f: FetchLike, url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await f(url, { ...init, signal: ctl.signal });
  } catch {
    // Network error, abort or TLS failure. Never include the URL (it can carry a key) in what we throw.
    throw new ProviderError("provider_unavailable");
  } finally {
    clearTimeout(timer);
  }
}

// ── Input parsing ────────────────────────────────────────────────────────────────────────────────────────────────

const IG_RESERVED = new Set(["p", "reel", "reels", "stories", "explore", "accounts", "tv", "direct", "about", "web", "developer"]);

/** Instagram username from "@name", "name" or an instagram.com URL. Throws bad_handle. */
export function parseInstagramHandle(input: string): string {
  let s = String(input ?? "").trim();
  if (!s || s.length > 200) throw new ProviderError("bad_handle");
  const m = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/([^/?#\s]+)/i);
  if (m) s = m[1];
  else if (/[/\s]/.test(s) || /^https?:/i.test(s)) throw new ProviderError("bad_handle");
  s = s.replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(s) || IG_RESERVED.has(s) || s.startsWith(".") || s.endsWith(".")) throw new ProviderError("bad_handle");
  return s;
}

export type YoutubeRef = { kind: "handle"; value: string } | { kind: "id"; value: string } | { kind: "user"; value: string };

/** YouTube channel reference from "@name", youtube.com/@name, /channel/UC..., /user/name or a bare name. Throws bad_handle. */
export function parseYoutubeRef(input: string): YoutubeRef {
  const s = String(input ?? "").trim();
  if (!s || s.length > 300) throw new ProviderError("bad_handle");
  const url = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(.+)$/i);
  if (url) {
    const path = url[1].split(/[?#]/)[0].replace(/\/+$/, "");
    let m = path.match(/^@([A-Za-z0-9._-]{3,60})(?:\/.*)?$/);
    if (m) return { kind: "handle", value: "@" + m[1] };
    m = path.match(/^channel\/(UC[A-Za-z0-9_-]{20,24})(?:\/.*)?$/);
    if (m) return { kind: "id", value: m[1] };
    m = path.match(/^user\/([A-Za-z0-9._-]{1,60})(?:\/.*)?$/);
    if (m) return { kind: "user", value: m[1] };
    throw new ProviderError("bad_handle");
  }
  if (/^UC[A-Za-z0-9_-]{20,24}$/.test(s)) return { kind: "id", value: s };
  const h = s.replace(/^@/, "");
  if (/^[A-Za-z0-9._-]{3,60}$/.test(h)) return { kind: "handle", value: "@" + h };
  throw new ProviderError("bad_handle");
}

// ── YouTube ──────────────────────────────────────────────────────────────────────────────────────────────────────

function ytAvatar(th: any): string | null {
  const u = (th?.medium ?? th?.default ?? th?.high)?.url;
  return typeof u === "string" && u.startsWith("https://") ? u : null;
}

export async function youtubeLookup(env: Pick<Env, "YOUTUBE_API_KEY">, handleOrUrl: string, f: FetchLike = fetch): Promise<ChannelLookup> {
  const ref = parseYoutubeRef(handleOrUrl);
  const key = (env.YOUTUBE_API_KEY ?? "").trim();
  if (!key) throw new ProviderError("provider_not_configured");
  const q = new URLSearchParams({ part: "snippet,statistics", key });
  q.set(ref.kind === "handle" ? "forHandle" : ref.kind === "id" ? "id" : "forUsername", ref.value);
  const res = await timedFetch(f, `https://www.googleapis.com/youtube/v3/channels?${q.toString()}`, { headers: { accept: "application/json" } });
  // 400/403 here means a bad or over-quota key: the person cannot fix it, so it is "unavailable", not "bad handle".
  if (!res.ok) throw new ProviderError("provider_unavailable");
  let body: any;
  try { body = await res.json(); } catch { throw new ProviderError("provider_unavailable"); }
  const item = Array.isArray(body?.items) ? body.items[0] : null;
  if (!item?.id) return { exists: false, platformUserId: null, handle: ref.kind === "handle" ? ref.value : "", followers: 0, bio: "", isPrivate: false, countHidden: false, url: "" };
  const hidden = item.statistics?.hiddenSubscriberCount === true;
  const subs = hidden ? 0 : Math.max(0, Math.trunc(Number(item.statistics?.subscriberCount ?? 0)) || 0);
  const custom = typeof item.snippet?.customUrl === "string" ? item.snippet.customUrl : "";
  const handle = custom ? (custom.startsWith("@") ? custom : "@" + custom) : ref.kind === "handle" ? ref.value : String(item.snippet?.title ?? item.id);
  return {
    exists: true,
    platformUserId: String(item.id),
    handle,
    followers: subs,
    views: Math.max(0, Math.trunc(Number(item.statistics?.viewCount ?? 0)) || 0),
    bio: String(item.snippet?.description ?? ""),
    isPrivate: false,
    countHidden: hidden,
    url: custom && custom.startsWith("@") ? `https://www.youtube.com/${custom}` : `https://www.youtube.com/channel/${item.id}`,
    displayName: String(item.snippet?.title ?? "").slice(0, 80),
    avatarUrl: ytAvatar(item.snippet?.thumbnails),
  };
}

// ── Instagram via treg ───────────────────────────────────────────────────────────────────────────────────────────

// [HF-IG-LOOKUP-FAST-1] scrapecreators answers in ~4 s, tikhub in ~7-8 s (often past the 8 s budget, then the fallback doubled the wait and the
// app timed out at 15 s with "Slow connection"). Fastest first.
export const TREG_IG_PROFILE = "scrapecreators.instagram.user.profile";
export const TREG_IG_PROFILE_FALLBACK = "tikhub.instagram.user.profile";

// [HF-CHANNEL-CHECK-20S-1] The app now waits up to 20 s (22 s request timeout). The whole Instagram lookup gets a 19 s budget: the primary
// attempt up to 10 s, the fallback only with the time left minus 1 s, so a check never runs past ~19 s server-side.
export const IG_LOOKUP_BUDGET_MS = 19000;
export const IG_PRIMARY_MAX_MS = 10000;
export const IG_FALLBACK_MARGIN_MS = 1000;
const IG_FALLBACK_MIN_MS = 1000;

export async function instagramLookup(env: Pick<Env, "TREG_API_KEY">, handleOrUrl: string, f: FetchLike = fetch): Promise<ChannelLookup> {
  const handle = parseInstagramHandle(handleOrUrl);
  const token = (env.TREG_API_KEY ?? "").trim();
  if (!token) throw new ProviderError("provider_not_configured");
  const started = Date.now();
  try {
    return await instagramProviderLookup(handle, token, TREG_IG_PROFILE, f, Math.min(IG_PRIMARY_MAX_MS, IG_LOOKUP_BUDGET_MS));
  } catch (error) {
    if (!(error instanceof ProviderError) || error.code !== "provider_unavailable") throw error;
    const left = IG_LOOKUP_BUDGET_MS - (Date.now() - started) - IG_FALLBACK_MARGIN_MS;
    if (left < IG_FALLBACK_MIN_MS) throw error;
    return instagramProviderLookup(handle, token, TREG_IG_PROFILE_FALLBACK, f, left);
  }
}

async function instagramProviderLookup(handle: string, token: string, endpoint: string, f: FetchLike, timeoutMs: number = PROVIDER_TIMEOUT_MS): Promise<ChannelLookup> {
  // Keep the full response, including JSON consumption, inside the provider budget.
  // Both attempts together fit the 19 s lookup budget (see instagramLookup). Do not log URLs, tokens,
  // handles or response bodies; these fixed fields diagnose production failures safely.
  const q = new URLSearchParams({ username: handle });
  if (endpoint === "scrapecreators.instagram.user.profile") q.set("handle", handle);
  const ctl = new AbortController();
  const started = Date.now();
  let stage = "fetch";
  let status: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let body: any;
  try {
    body = await Promise.race([
      (async () => {
        const res = await f(`https://treg.to/call/${endpoint}?${q.toString()}`, {
          headers: { "X-Treg-Token": token, accept: "application/json" }, signal: ctl.signal,
        });
        status = res.status;
        if (!res.ok) throw new ProviderError("provider_unavailable");
        stage = "json";
        return res.json();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stage += "_timeout";
          reject(new ProviderError("provider_unavailable"));
          ctl.abort();
        }, timeoutMs);
      }),
    ]);
    stage = "profile";
    return parseInstagramProfile(body, handle);
  } catch {
    console.warn("[hf_instagram_lookup]", { endpoint, stage, status, elapsedMs: Date.now() - started });
    throw new ProviderError("provider_unavailable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseInstagramProfile(body: any, handle: string): ChannelLookup {
  const profileUrl = `https://www.instagram.com/${handle}/`;
  const user = body?.data?.data?.user ?? body?.data?.user ?? body?.user;
  const gone = { exists: false, platformUserId: null, handle, followers: 0, bio: "", isPrivate: false, countHidden: false, url: profileUrl } as ChannelLookup;
  if (body?.error === "not_found" || body?.errorStatus === 404) return gone;
  // Explicit null user is an absent account; an unrecognised/error envelope is a provider failure.
  if (!user && (body?.data?.data?.user === null || body?.data?.user === null || body?.user === null)
      && body?.success !== false && !body?.error) return gone;
  if (!user || typeof user !== "object") throw new ProviderError("provider_unavailable");
  const id = user.id ?? user.pk ?? body?.userId ?? body?.data?.userId ?? null;
  if (id == null || String(id) === "") throw new ProviderError("provider_unavailable");
  const followers = Math.max(0, Math.trunc(Number(user.edge_followed_by?.count ?? user.follower_count ?? user.followers ?? 0)) || 0);
  return {
    exists: true,
    platformUserId: String(id),
    handle: String(user.username ?? handle).toLowerCase(),
    followers,
    bio: String(user.biography ?? ""),
    isPrivate: user.is_private === true || body?.is_private === true || body?.message === "Profile is private",
    countHidden: false,
    url: profileUrl,
    displayName: String(user.full_name ?? "").slice(0, 80),
    avatarUrl: typeof (user.profile_pic_url_hd ?? user.profile_pic_url) === "string" && String(user.profile_pic_url_hd ?? user.profile_pic_url).startsWith("https://") ? String(user.profile_pic_url_hd ?? user.profile_pic_url) : null,
  };
}

export function lookupChannel(env: Env, platform: ChannelPlatform, handleOrUrl: string, f: FetchLike = fetch): Promise<ChannelLookup> {
  return platform === "youtube" ? youtubeLookup(env, handleOrUrl, f) : instagramLookup(env, handleOrUrl, f);
}

// ── Ownership code ───────────────────────────────────────────────────────────────────────────────────────────────

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I

/** One-time ownership code such as "HF-7K3Q9". */
export function makeVerifyCode(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `HF-${s}`;
}

/** True when [bio] contains [code], ignoring case, spaces, and the dash (some apps and fonts change or drop it). */
export function bioHasCode(bio: string, code: string): boolean {
  const squash = (x: string) => x.toUpperCase().replace(/[\s\-‐-―−]/g, "");
  const c = squash(code);
  return c.length >= 6 && squash(bio).includes(c);
}

/** [HF-WIRE-14] The channel that belongs to the person who owns `accessToken` (YouTube Data API channels.list?mine=true, scope youtube.readonly).
 * Google only answers with the token holder's own channel, so a hit PROVES ownership. The token is used for this one call and is never stored or logged.
 * Throws token_invalid when Google rejects the token (expired, wrong scope), provider_unavailable on any other failure. exists=false: no YouTube channel on that account. */
export async function youtubeOwnChannel(accessToken: string, f: FetchLike = fetch): Promise<ChannelLookup> {
  const tok = String(accessToken ?? "").trim();
  if (!/^[A-Za-z0-9._~+/=-]{20,4096}$/.test(tok)) throw new ProviderError("token_invalid");
  const res = await timedFetch(f, "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true", { headers: { authorization: `Bearer ${tok}`, accept: "application/json" } });
  if (res.status === 401 || res.status === 403) throw new ProviderError("token_invalid");
  if (!res.ok) throw new ProviderError("provider_unavailable");
  let body: any;
  try { body = await res.json(); } catch { throw new ProviderError("provider_unavailable"); }
  const it = Array.isArray(body?.items) ? body.items[0] : null;
  const id = String(it?.id ?? "");
  if (!/^UC[A-Za-z0-9_-]{20,24}$/.test(id)) return { exists: false, platformUserId: null, handle: "", followers: 0, bio: "", isPrivate: false, countHidden: false, url: "" };
  const custom = String(it?.snippet?.customUrl ?? "").trim();
  const hidden = it?.statistics?.hiddenSubscriberCount === true;
  return {
    exists: true, platformUserId: id, handle: custom ? (custom.startsWith("@") ? custom : "@" + custom) : String(it?.snippet?.title ?? id).slice(0, 80),
    followers: Math.max(0, Math.trunc(Number(it?.statistics?.subscriberCount ?? 0)) || 0), views: Math.max(0, Math.trunc(Number(it?.statistics?.viewCount ?? 0)) || 0), bio: String(it?.snippet?.description ?? ""), isPrivate: false, countHidden: hidden,
    url: `https://www.youtube.com/channel/${id}`,
  };
}
