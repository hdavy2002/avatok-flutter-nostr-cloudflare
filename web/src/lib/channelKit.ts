/* [HF-CHANNEL-WEB-1] Small pure helpers shared by the channel page islands: reel embeds, number and time formatting. */
export interface ChannelReel { id: string; platform: string; url: string; embedUrl?: string | null; thumbUrl: string | null; title: string | null; views?: number | null }
export const PLATFORM_LABEL: Record<string, string> = { youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' };

export const compact = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '')}K` : String(n);

const YT_EMBED = /^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{6,20})(?:\?.*)?$/;
const YT_WATCH = /^https:\/\/(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)([A-Za-z0-9_-]{6,20})/;
const YT_SHORT = /^https:\/\/youtu\.be\/([A-Za-z0-9_-]{6,20})/;
const IG_EMBED = /^https:\/\/www\.instagram\.com\/(?:reel|p|reels)\/([A-Za-z0-9_-]+)\/embed\/?$/;
const IG_PAGE = /^https:\/\/www\.instagram\.com\/(?:reel|p|reels)\/([A-Za-z0-9_-]+)\/?/;

/** The official, privacy-friendly player for a reel, or null when the platform has no embeddable player (then the tile links out).
 *  We never host video. Only these three hosts can ever end up in an iframe src. */
export function embedFor(r: ChannelReel, autoplay = true): { src: string; platform: 'youtube' | 'instagram'; ratio: '16/9' | '9/16' } | null {
  const e = r.embedUrl ?? '';
  const yt = YT_EMBED.exec(e) ?? YT_WATCH.exec(r.url) ?? YT_SHORT.exec(r.url);
  if (r.platform === 'youtube' && yt) return { src: `https://www.youtube-nocookie.com/embed/${yt[1]}?rel=0&playsinline=1${autoplay ? '&autoplay=1' : ''}`, platform: 'youtube', ratio: /\/shorts\//.test(r.url) ? '9/16' : '16/9' };
  const ig = IG_EMBED.exec(e) ?? IG_PAGE.exec(r.url);
  if (r.platform === 'instagram' && ig) return { src: `https://www.instagram.com/reel/${ig[1]}/embed`, platform: 'instagram', ratio: '9/16' };
  return null;
}
export const isShort = (r: ChannelReel): boolean => /\/shorts\//.test(r.url);

/** "Humphrey Davy" -> ["Humphrey", "Davy"] for the two-line hero name (one line on phones). */
export function splitName(name: string): [string, string] {
  const t = name.trim().replace(/\s+/g, ' ');
  const i = t.indexOf(' ');
  return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1)];
}
/** Two-letter language tag for the stats row: "en" -> "EN", "Hindi" -> "HI". */
export function langTag(v: string): string {
  const s = v.trim();
  if (!s) return '';
  if (s.length <= 3) return s.toUpperCase();
  const MAP: Record<string, string> = { hindi: 'HI', english: 'EN', marathi: 'MR', bengali: 'BN', tamil: 'TA', telugu: 'TE', kannada: 'KN', malayalam: 'ML', gujarati: 'GU', punjabi: 'PA', odia: 'OR', bhojpuri: 'BHO', garhwali: 'GBM', kumaoni: 'KFY', urdu: 'UR', assamese: 'AS' };
  return MAP[s.toLowerCase()] ?? s.slice(0, 2).toUpperCase();
}
export const fmtDuration = (secs: number): string => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
