/* [HF-EXPLORE-PUBLIC-1] Shared types + small pure helpers for the public reels page (/explore, /r/<id>) and the not-on-network creator page (/i/<platform>/<handle>).
 * Embeds only (HF-REEL-32 / HF-WEB-NOOUT-1): we never host video and never link out to YouTube / Instagram. */
import { embedFor, type ChannelReel } from './channelKit';
import { BRAND } from './brand';

export interface ReelHost { slug: string; name: string; handle: string | null; avatar: string | null; followers?: number; presence?: string; greenTick?: boolean; ratePaise?: number; callState?: string; queue?: { open?: boolean; waiting?: number } }
export interface ReelCreator { platform: string; handle: string; name: string; avatar: string | null; followers: number; votes: number; joinedSlug?: string }
/** One item of GET /api/hf/reels (network items have `host`, invite items have `kind:"invite"` + `creator`). */
/** [HF-INTRO-B3] One verified social account on an intro reel (platform = youtube | instagram | facebook). */
export interface IntroSocial { platform: string; handle: string; url: string; followers?: number }
export type MainAction = 'call' | 'queue_or_book' | 'book' | 'none';
export interface ReelItem {
  id: string; kind?: 'invite' | 'intro'; host?: ReelHost; creator?: ReelCreator;
  platform: string; url: string; embedUrl?: string | null; thumbUrl: string | null; title: string; caption: string;
  likes: number; comments: number; views: number; publishedAt: number | null; likedByMe?: boolean;
  /** [HF-INTRO-B3] intro-video fields (kind 'intro', flag hfIntroReelsEnabled) */
  videoUrl?: string | null; posterUrl?: string | null; categories?: { id: string; label: string }[]; description?: string;
  ratePaise?: number; callOption?: 'A' | 'B' | null; callState?: string; mainAction?: MainAction; womenOnly?: boolean; greenTick?: boolean;
  socials?: IntroSocial[]; shareUrl?: string;
}

export const isIntro = (r: ReelItem | null | undefined): boolean => r?.kind === 'intro';
/** "20" -> "₹20/min", 3.99 rupees -> "₹3.99/min". */
export const introRate = (paise: number | undefined): string => `₹${((paise ?? 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}/min`;
/** The one main button of an intro reel. Older servers send no mainAction: derive it from callOption + callState (same table as the API notes). */
export function mainActionOf(r: ReelItem): MainAction {
  if (r.mainAction) return r.mainAction;
  if (r.callOption === 'A') return 'book';
  const s = r.callState ?? r.host?.callState;
  if (s === 'available') return 'call';
  if (s === 'on_call' || s === 'connecting' || s === 'queue_only') return 'queue_or_book';
  return 'book';
}
/** Only https links to the three social platforms are opened (the value comes from our server, but never trust a URL blindly). */
export const safeSocialUrl = (u: string | undefined): string | null => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);
export const PLATFORM_NAME: Record<string, string> = { youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' };

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
  // [HF-REEL-OVERLAY-WEB-1] controls=1: a Short then draws its own Shorts UI (sound icon + menu on top, like / share, title + channel); our tap layer covers
  // all of it except the sound icon. fs=0 hides fullscreen; enablejsapi lets our tap layer play / pause and lets us hear the player's muted state.
  return {
    platform: 'youtube', videoId: id,
    src: (autoplay, origin) => `https://www.youtube-nocookie.com/embed/${id}?controls=1&modestbranding=1&rel=0&playsinline=1&iv_load_policy=3&disablekb=1&fs=0&enablejsapi=1&mute=1&loop=1&playlist=${id}&autoplay=${autoplay ? 1 : 0}&origin=${encodeURIComponent(origin)}`,
  };
}

/** Items the page can actually play. */
export const playable = (items: ReelItem[]): ReelItem[] => items.filter(i => (isIntro(i) ? !!i.videoUrl : !!playerFor(i)));

/** [HF-REEL-OVERLAY-WEB-1] YouTube: the player is shown as it is, fitted in a 9:16 box (it draws its own title / channel, like / share, sound icon, menu).
 * Instagram: the embed is a card (header on top, caption / likes below). Make it wide enough that its media box is as tall as the frame: the reel then fills
 * the frame, the black side bars fall outside it, the ~58px header is pushed above and the likes / caption below (the white card is hidden). */
export function sizeFor(frameW: number, frameH: number, platform: 'youtube' | 'instagram'): { width: number; height: number; left: number; top: number } {
  if (platform === 'instagram') {
    const w = (frameH / 1.215) * 1.04;
    return { width: w, height: 58 + w * 1.215 + 320, left: (frameW - w) / 2, top: -58 - (w * 1.215 - frameH) / 2 };
  }
  const w = Math.min(frameW, (frameH * 9) / 16);
  const h = (w * 16) / 9;
  return { width: w, height: h, left: (frameW - w) / 2, top: (frameH - h) / 2 };
}

/** [HF-REEL-OVERLAY-WEB-1] Where YouTube draws its own sound (mute) icon, in the player box's own coordinates (px from its top-left). Our see-through
 * tap layer covers the whole box EXCEPT this hole, so that icon is clickable while everything else (title, channel, menu, like / share) is not.
 * Measured 2026-10-26 in Chrome (box 682 px wide, icons ~22 px from the top). YouTube draws TWO layouts: the Shorts one (touch / no mouse activity: speaker
 * centre 73 px from the right edge, 3-dot menu centre 34 px) and the desktop one once the mouse is over the player (speaker centre 145, CC 96, settings 49).
 * The hole spans 165..62 px from the right edge: both speakers, never the Shorts 3-dot menu. */
export const YT_MUTE_HOLE = { fromRight: 165, toRight: 62, top: 2, bottom: 46 };
export function ytMuteHole(boxW: number, _boxH: number): { left: number; right: number; top: number; bottom: number } {
  return { left: Math.max(0, boxW - YT_MUTE_HOLE.fromRight), right: Math.max(0, boxW - YT_MUTE_HOLE.toRight), top: YT_MUTE_HOLE.top, bottom: YT_MUTE_HOLE.bottom };
}
/** CSS clip-path (px, relative to the tap layer = the player box) that cuts the mute hole out of the tap layer (clipped areas get no clicks). */
export function tapClipPath(boxW: number, boxH: number): string {
  const h = ytMuteHole(boxW, boxH);
  const f = (n: number) => `${Math.round(n * 10) / 10}px`;
  return `polygon(evenodd, 0 0, ${f(boxW)} 0, ${f(boxW)} ${f(boxH)}, 0 ${f(boxH)}, 0 0, ${f(h.left)} ${f(h.top)}, ${f(h.right)} ${f(h.top)}, ${f(h.right)} ${f(h.bottom)}, ${f(h.left)} ${f(h.bottom)}, ${f(h.left)} ${f(h.top)})`;
}

export const compactCount = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '')}K` : String(Math.max(0, Math.trunc(n || 0)));

export const signInHref = (backPath: string, google = false): string => `/sign-in?${google ? 'google=1&' : ''}redirect_url=${encodeURIComponent(backPath)}`;
/** The WhatsApp gate every like / comment / vote needs when the account has no verified WhatsApp number yet. */
export const whatsappGateHref = (backPath: string): string => `/sign-up?finish=1&redirect_url=${encodeURIComponent(backPath)}`;

export type GateAction = 'like' | 'comment' | 'save' | 'vote' | 'call';
export const GATE_COPY: Record<GateAction, { title: string; line: string }> = {
  like: { title: 'Loved this reel?', line: 'Sign in to like it and tell the creator.' },
  comment: { title: 'Want to say something?', line: 'Sign in to join the conversation.' },
  save: { title: 'Keep it for later?', line: 'Sign in to save this reel.' },
  call: { title: 'Want to talk to them?', line: 'Sign in to call, join the queue or book a time.' },
  vote: { title: 'Want them here?', line: `Sign in to vote for them to join ${BRAND.name}.` },
};

/** Post a command to a YouTube iframe that was loaded with enablejsapi=1 (play / pause / mute from our own tap layer). */
export function ytCmd(el: HTMLIFrameElement | null | undefined, func: string, args: unknown[] = []): void {
  try { el?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), 'https://www.youtube-nocookie.com'); } catch { /* player not ready yet: callers retry */ }
}
