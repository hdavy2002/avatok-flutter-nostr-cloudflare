// [HF-PAGES-2] The 14 Hello Fraands policy pages read their text from the API (D1 `site_pages`, HF-PAGES-1).
// If the API is down, slow or returns something unusable, the page shows the SEED text instead: web/src/data/hf-pages-seed.json,
// generated once from the old hard-coded pages by scripts/hf_pages_extract.mjs --json (never hand-retyped).
// Block shapes mirror worker/src/lib/hf_pages.ts.
import seed from '../data/hf-pages-seed.json';
import { BRAND } from './brand';
import { BUSINESS_CONTACT } from './businessContact';
import { API_BASE } from './env';

export type Span = { text: string; href?: string; em?: boolean; strong?: boolean };
export type Block =
  | { t: 'h2'; text: string }
  | { t: 'p'; spans: Span[]; lang?: string }
  | { t: 'note'; spans: Span[] }
  | { t: 'ul' | 'ol'; items: Span[][] }
  | { t: 'links'; items: { href: string; title: string; text: string }[] };
export type Related = { href: string; label: string };
export interface PolicyPageData {
  slug: string; title: string; summary: string; updated: string; review: boolean;
  related: Related[]; version: number; blocks: Block[]; source: 'api' | 'seed';
}

interface SeedPage { title: string; summary: string; updated: string; review: boolean; related: Related[]; version: number; blocks: Block[] }
const SEED = seed as unknown as Record<string, SeedPage>;
export const POLICY_SLUGS = Object.keys(SEED);

const PLACEHOLDER_RE = /\{((?:brand|business)\.[A-Za-z]+(?:\.[A-Za-z]+)?)\}/g;
function lookup(path: string): string | null {
  const [root, ...rest] = path.split('.');
  let v: unknown = root === 'brand' ? BRAND : root === 'business' ? BUSINESS_CONTACT : undefined;
  for (const k of rest) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  return typeof v === 'string' ? v : null;
}
/** Same rule as the worker: {brand.*} / {business.*}; unknown placeholders stay as written. */
export const resolvePlaceholders = (s: string): string => s.replace(PLACEHOLDER_RE, (m, p: string) => lookup(p) ?? m);

const mapSpans = (spans: Span[]): Span[] => spans.map((s) => ({ ...s, text: resolvePlaceholders(s.text), ...(s.href ? { href: resolvePlaceholders(s.href) } : {}) }));
function resolveBlocks(blocks: Block[]): Block[] {
  return blocks.map((b): Block => {
    switch (b.t) {
      case 'h2': return { ...b, text: resolvePlaceholders(b.text) };
      case 'p': case 'note': return { ...b, spans: mapSpans(b.spans) };
      case 'ul': case 'ol': return { ...b, items: b.items.map(mapSpans) };
      case 'links': return { ...b, items: b.items.map((i) => ({ href: i.href, title: resolvePlaceholders(i.title), text: resolvePlaceholders(i.text) })) };
    }
  });
}

/** The committed text for a slug, placeholders resolved. null for a slug that is not one of the 14. */
export function seedPage(slug: string): PolicyPageData | null {
  const s = SEED[slug];
  if (!s) return null;
  return {
    slug, title: resolvePlaceholders(s.title), summary: resolvePlaceholders(s.summary), updated: s.updated, review: s.review,
    related: s.related.map((r) => ({ href: r.href, label: resolvePlaceholders(r.label) })), version: s.version, blocks: resolveBlocks(s.blocks), source: 'seed',
  };
}

// Text context needs only & < >; quotes stay literal so the markup (and the layout's heading-derived anchor ids) match the old pages.
const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const escText = (s: string) => s.replace(/[&<>]/g, (c) => HTML_ESC[c]);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => HTML_ESC[c]);
const safeHref = (h: string) => /^(\/(?!\/)|https:\/\/|mailto:|tel:)/.test(h);

/** Spans -> escaped inline HTML. "\n" becomes <br>. Links outermost, then strong, then em. */
export function spansToHtml(spans: Span[]): string {
  return spans.map((s) => {
    if (s.text === '\n') return '<br>';
    let h = escText(s.text);
    if (s.em) h = `<em>${h}</em>`;
    if (s.strong) h = `<strong>${h}</strong>`;
    if (s.href && safeHref(s.href)) h = `<a href="${esc(s.href)}">${h}</a>`;
    return h;
  }).join('');
}

const BLOCK_TYPES = new Set(['h2', 'p', 'note', 'ul', 'ol', 'links']);
const isStr = (v: unknown): v is string => typeof v === 'string';
function blockShapeOk(b: any): boolean {
  if (!b || typeof b !== 'object' || !BLOCK_TYPES.has(b.t)) return false;
  const spansOk = (x: any) => Array.isArray(x) && x.length > 0 && x.every((s: any) => s && isStr(s.text));
  switch (b.t) {
    case 'h2': return isStr(b.text);
    case 'p': case 'note': return spansOk(b.spans);
    case 'ul': case 'ol': return Array.isArray(b.items) && b.items.length > 0 && b.items.every(spansOk);
    default: return Array.isArray(b.items) && b.items.length > 0 && b.items.every((i: any) => i && isStr(i.href) && isStr(i.title) && isStr(i.text));
  }
}

/**
 * Fetch the live page from the API (edge-cached for a minute on top of the API's own Cache-Control). Returns null on any
 * failure (network, timeout, non-200, bad shape) so the caller falls back to the seed text.
 * The API has already resolved placeholders.
 */
export async function fetchLivePage(slug: string): Promise<PolicyPageData | null> {
  if (!SEED[slug]) return null;
  try {
    const res = await fetch(`${API_BASE}/api/hf/pages/${slug}`, {
      signal: AbortSignal.timeout(3000),
      headers: { accept: 'application/json' },
      // Cloudflare-only hint, ignored elsewhere (astro dev): keep the API from being hit on every page view.
      cf: { cacheTtl: 60, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) return null;
    const j: any = await res.json();
    if (!j || j.ok !== true || !isStr(j.title) || !Array.isArray(j.blocks) || j.blocks.length === 0 || !j.blocks.every(blockShapeOk)) return null;
    const s = SEED[slug];
    return {
      slug, title: j.title, summary: isStr(j.summary) ? j.summary : '', updated: isStr(j.updatedAt) ? j.updatedAt : s.updated,
      review: s.review, // not stored in D1: a per-page layout flag that never changes with an edit
      related: Array.isArray(j.related) ? j.related.filter((r: any) => r && isStr(r.href) && isStr(r.label) && r.href.startsWith('/') && !r.href.startsWith('//')) : [],
      version: Number(j.version) || 0, blocks: j.blocks as Block[], source: 'api',
    };
  } catch {
    return null;
  }
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
/**
 * Short fingerprint of what the reader sees (title, summary, date, related, text). The static page bakes the seed's stamp; the live
 * twin sends its own in a response header; the browser swaps the page only when they differ, so an unedited page never flickers.
 */
export function contentStamp(d: PolicyPageData): string {
  const str = stable([d.title, d.summary, d.updated, d.related, d.blocks]);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
