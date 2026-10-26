/* [HF-EXPLORE-PUBLIC-1] Shared types + small pure helpers for the public reels page (/explore, /r/<id>) and the not-on-network creator page (/i/<platform>/<handle>).
 * Embeds only (HF-REEL-32 / HF-WEB-NOOUT-1): we never host video and never link out to YouTube / Instagram. */
import { embedFor, type ChannelReel } from './channelKit';
import { BRAND } from './brand';

export interface ReelHost { slug: string; name: string; handle: string | null; avatar: string | null; followers?: number; presence?: string }
export interface ReelCreator { platform: string; handle: string; name: string; avatar: string | null; followers: number; votes: number; joinedSlug?: string }
/** One item of GET /api/hf/reels (network items have `host`, invite items have `kind:"invite"` + `creator`). */
export interface ReelItem {
  id: string; kind?: 'invite'; host?: ReelHost; creator?: ReelCreator;
  platform: string; url: string; embedUrl?: string | null; thumbUrl: string | null; title: string; caption: string;
  likes: number; comments: number; views: number; publishedAt: number | null; likedByMe?: boolean;
}

/** Who the reel belongs to, with the page their photo and Call button open. Network host -> /h/<slug>; invite creator -> /i/<platform>/<handle>. */
export function whoOf(item: ReelItem): { name: string; avatar: string | null; href: string } {
  if (item.host) return { name: item.host.name || 'this creator', avatar: item.host.avatar, href: `/h/${encodeURIComponent(item.host.slug)}` };
  const c = item.creator;
  const handle = (c?.handle ?? '').replace(/^@/, '');
  return { name: (c?.name || (handle ? `@${handle}` : 'this creator')), avatar: c?.avatar ?? null, href: c ? `/i/${encodeURIComponent(c.platform)}/${encodeURIComponent(handle)}` : '/explore' };
}

export const toChannelReel = (r: ReelItem): ChannelReel => ({ id: r.id, platform: r.platform, url: r.url, embedUrl: r.embedUrl ?? null, thumbUrl: r.thumbUrl, title: r.title });

export type PlayerSpec =
  | { platform: 'youtube'; videoId: string; src: (autoplay: boolean, origin: string) => string }
  | { platform: 'instagram'; src: string };

/** The official player for a reel, or null when it has no embeddable player (then the item is skipped). */
export function playerFor(r: ReelItem): PlayerSpec | null {
  const e = embedFor(toChannelReel(r), false);
  if (!e) return null;
  if (e.platform === 'instagram') return { platform: 'instagram', src: e.src };
  const id = /\/embed\/([A-Za-z0-9_-]{6,20})/.exec(e.src)?.[1];
  if (!id) return null;
  // controls=0 + modestbranding + iv_load_policy=3 + fs=0 hide the player UI; enablejsapi lets our own tap layer play / pause / mute it.
  return {
    platform: 'youtube', videoId: id,
    src: (autoplay, origin) => `https://www.youtube-nocookie.com/embed/${id}?controls=0&modestbranding=1&rel=0&playsinline=1&iv_load_policy=3&disablekb=1&fs=0&enablejsapi=1&mute=1&loop=1&playlist=${id}&autoplay=${autoplay ? 1 : 0}&origin=${encodeURIComponent(origin)}`,
  };
}

/** Items the page can actually play. */
export const playable = (items: ReelItem[]): ReelItem[] => items.filter(i => !!playerFor(i));

/** [HF-REEL-RAW-WEB-1] The platform players are shown as they are: no crop, no zoom. The iframe is fitted INSIDE the frame at its natural
 * shape and centred; the rest of the frame stays black (letterbox). YouTube: a 9:16 box, so a Short fills it and the player draws its own
 * title / channel (top) and logo (bottom). Instagram: the card is taller than 9:16 (header + media up to ~4:5 + footer), so it is fitted by
 * height and capped at Instagram's own maximum embed width. */
export function sizeFor(frameW: number, frameH: number, platform: 'youtube' | 'instagram'): { width: number; height: number; left: number; top: number } {
  let w: number;
  let h: number;
  if (platform === 'instagram') {
    w = Math.max(120, Math.min(frameW, 540, (frameH - IG_CHROME_PX) / IG_MEDIA_RATIO));
    h = w * IG_MEDIA_RATIO + IG_CHROME_PX;
  } else {
    w = Math.min(frameW, (frameH * 9) / 16);
    h = (w * 16) / 9;
  }
  return { width: w, height: h, left: (frameW - w) / 2, top: (frameH - h) / 2 };
}
const IG_MEDIA_RATIO = 1.25; // the media area is at most 4:5
const IG_CHROME_PX = 250; // measured 2026-10-26: header ~55 + footer (View more, actions, likes, add a comment) ~190

/** YouTube draws a title + channel band on top and its logo at the bottom of the player; taps there must reach YouTube (it opens its own link in a new tab). */
export const YT_BAND_TOP = 64;
export const YT_BAND_BOTTOM = 56;
/** The area our see-through tap layer covers: the player box, minus YouTube's link bands. */
export function tapBoxFor(box: { width: number; height: number; left: number; top: number }, platform: 'youtube' | 'instagram'): { width: number; height: number; left: number; top: number } {
  if (platform !== 'youtube') return box;
  const h = Math.max(0, box.height - YT_BAND_TOP - YT_BAND_BOTTOM);
  return { width: box.width, height: h, left: box.left, top: box.top + YT_BAND_TOP };
}

export const compactCount = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '')}K` : String(Math.max(0, Math.trunc(n || 0)));

export const signInHref = (backPath: string, google = false): string => `/sign-in?${google ? 'google=1&' : ''}redirect_url=${encodeURIComponent(backPath)}`;
/** The WhatsApp gate every like / comment / vote needs when the account has no verified WhatsApp number yet. */
export const whatsappGateHref = (backPath: string): string => `/sign-up?finish=1&redirect_url=${encodeURIComponent(backPath)}`;

export type GateAction = 'like' | 'comment' | 'save' | 'vote';
export const GATE_COPY: Record<GateAction, { title: string; line: string }> = {
  like: { title: 'Loved this reel?', line: 'Sign in to like it and tell the creator.' },
  comment: { title: 'Want to say something?', line: 'Sign in to join the conversation.' },
  save: { title: 'Keep it for later?', line: 'Sign in to save this reel.' },
  vote: { title: 'Want them here?', line: `Sign in to vote for them to join ${BRAND.name}.` },
};

/** Post a command to a YouTube iframe that was loaded with enablejsapi=1 (play / pause / mute from our own tap layer). */
export function ytCmd(el: HTMLIFrameElement | null | undefined, func: string, args: unknown[] = []): void {
  try { el?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), 'https://www.youtube-nocookie.com'); } catch { /* player not ready yet: callers retry */ }
}
