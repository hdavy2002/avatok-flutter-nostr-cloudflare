// [SAATHUM-EVENT-FIELDS-1 2026-09-26] OWNER DECISION: "Start from an article".
//
// NOTE FOR AI:
//  - The admin New event form has a dropdown of every Puja & Havan Guide article
//    (web/src/lib/ritualGuides.ts). Picking one pre-fills the form from it, so a
//    listing is written in seconds instead of minutes.
//  - Only fields the article actually knows are filled. Location, date, start time,
//    capacity, "performed by" and the YouTube link are NEVER guessed — the owner fills
//    them. Prasad courier / 7-day replay are left as they are.
//  - Price comes from the pricing backend (/api/pricing, edited at /admin/prices) —
//    never from a number written in an article.
//  - The article's own photo becomes the cover: fetched from the site, re-uploaded
//    through /upload/public so the listing owns its copy (same as a manual upload).
//  - Everything here is pure except articleCover() (network).
import { rituals, ritualCategories, type Ritual } from '../../lib/ritualGuides';
import { storyFor } from '../../lib/ritualStories';
import { fetchPricing, ritualPrice } from '../../lib/pricing';
import { publicImage } from '../../lib/config';
import { uploadCover } from './eventsApi';

export { rituals as articles };
export type Article = Ritual;

export const articleBySlug = (slug: string | null | undefined): Article | null =>
  (slug ? rituals.find((r) => r.slug === slug) : null) ?? null;

/** Havans first, then pujas, each A–Z — the order of the dropdown. */
export function articleGroups(): { label: string; items: Article[] }[] {
  const by = (t: Article['type']) => rituals.filter((r) => r.type === t).sort((a, b) => a.title.localeCompare(b.title));
  return [{ label: 'Havans', items: by('havan') }, { label: 'Pujas', items: by('puja') }];
}

function cut(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const c = t.slice(0, max - 1).replace(/[\s,;:.\-–—]+\S*$/, '');
  return (c || t.slice(0, max - 1)) + '…';
}

/** "60–90 min" → 60; "2–3 hours" → 120; anything under 30 min → 30 (see the floor below). */
export function durationFromArticle(text: string): number | null {
  const m = /(\d+)(?:\s*[–-]\s*(\d+))?\s*(min|minutes|hr|hrs|hour|hours)/i.exec(text);
  if (!m) return null;
  const lo = Number(m[1]);
  const unit = /^h/i.test(m[3]) ? 60 : 1;
  const v = lo * unit;
  // A live event shorter than 30 minutes is not worth scheduling; the admin can change it.
  return Math.min(480, Math.max(30, v));
}

/** The long description a customer reads on the booking page. */
export function descriptionFromArticle(a: Article): string {
  const story = storyFor(a.slug);
  const parts: string[] = [a.description];
  if (story?.why) parts.push(`Why ${a.deity}\n${story.why}`);
  if (story?.story) parts.push(`The story behind it\n${story.story}`);
  if (a.benefits.length) parts.push(`What devotees traditionally seek\n${a.benefits.map((b) => `• ${b}`).join('\n')}`);
  if (a.whoFor) parts.push(`Who it is for\n${a.whoFor}`);
  if (a.offerings) parts.push(`Offerings made on your behalf\n${a.offerings}`);
  if (a.note) parts.push(a.note);
  return cut(parts.join('\n\n'), 6000);
}

export function blurbFromArticle(a: Article): string {
  const first = /^(.{20,}?[.!?])(\s|$)/.exec(a.description.trim())?.[1] ?? a.description;
  return cut(first, 120);
}

/** Pick a listing category for the ritual type from what the server offers. */
export function categoryFor(a: Article, cats: { id: string; label: string }[]): string | null {
  const want = a.type === 'havan' ? /havan|ritual|yagya|yajna/i : /puja/i;
  return cats.find((c) => want.test(c.label) || want.test(c.id))?.id
    ?? cats.find((c) => /puja/i.test(c.label) || /puja/i.test(c.id))?.id
    ?? null;
}

export interface ArticleFill {
  title: string;
  deity: string;
  blurb: string;
  description: string;
  intention: string;
  guide_slug: string;
  duration_min?: string;
  category?: string;
  price_rupees?: string;
}

/** Everything the article knows, as form values (strings, like the form). */
export async function fillFromArticle(a: Article, opts: { categories: { id: string; label: string }[]; minPrice: number }): Promise<ArticleFill> {
  const out: ArticleFill = {
    title: cut(a.title, 120),
    deity: cut(a.deity, 60),
    blurb: blurbFromArticle(a),
    description: descriptionFromArticle(a),
    intention: a.category in ritualCategories ? a.category : '',
    guide_slug: a.slug,
  };
  const d = durationFromArticle(a.duration);
  if (d) out.duration_min = String(d);
  const cat = categoryFor(a, opts.categories);
  if (cat) out.category = cat;
  try {
    const p = ritualPrice(await fetchPricing(), a);
    if (p != null && p >= opts.minPrice) out.price_rupees = String(p);
  } catch { /* no price → the owner types one */ }
  return out;
}

/** Fetch the article's photo from the site and upload it as this event's cover. */
export async function articleCover(a: Article): Promise<string> {
  const candidates = [
    publicImage(a.image, { width: 1200, fit: 'scale-down', format: 'jpeg', quality: 85 }),
    a.image,
  ];
  let lastErr: unknown = null;
  for (const src of candidates) {
    try {
      const res = await fetch(src, { credentials: 'omit' });
      if (!res.ok) throw new Error(`Image ${res.status}`);
      const blob = await res.blob();
      const type = ['image/jpeg', 'image/png', 'image/webp'].includes(blob.type) ? blob.type : 'image/jpeg';
      const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      return await uploadCover(new File([blob], `${a.slug}.${ext}`, { type }));
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('Could not load the article photo.');
}
