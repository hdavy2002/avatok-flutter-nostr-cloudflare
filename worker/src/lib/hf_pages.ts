// [HF-PAGES-1] Policy pages stored in D1 `site_pages`: block types, validation and placeholder resolution.
// The website and the app render the same blocks. Placeholders ({brand.name}, {business.postalAddress} ...) are
// resolved here at read time so a brand/contact change needs no page edit.
import { BRAND } from "./brand";
import { BUSINESS_CONTACT } from "./business_contact";

export type Span = { text: string; href?: string; em?: true; strong?: true };
export type Block =
  | { t: "h2"; text: string }
  | { t: "p"; spans: Span[]; lang?: string }
  | { t: "note"; spans: Span[] }
  | { t: "ul" | "ol"; items: Span[][] }
  | { t: "links"; items: { href: string; title: string; text: string }[] };
export type Related = { href: string; label: string };

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BLOCKS = 400;
const MAX_TEXT = 20000;
const PLACEHOLDER_RE = /\{((?:brand|business)\.[A-Za-z]+(?:\.[A-Za-z]+)?)\}/g;
const ANY_BRACE_RE = /\{[^}]*\}/g;

function lookup(path: string): string | null {
  const [root, ...rest] = path.split(".");
  let v: unknown = root === "brand" ? BRAND : root === "business" ? BUSINESS_CONTACT : undefined;
  for (const k of rest) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
  return typeof v === "string" ? v : null;
}

/** Replace {brand.*} / {business.*}. Unknown placeholders are left as written (validation rejects them on save). */
export function resolvePlaceholders(s: string): string {
  return s.replace(PLACEHOLDER_RE, (m, path: string) => lookup(path) ?? m);
}

/** A string is clean when every {...} in it is a known placeholder. */
function placeholdersOk(s: string): boolean {
  return (s.match(ANY_BRACE_RE) ?? []).every((m) => lookup(m.slice(1, -1)) !== null);
}

const isStr = (v: unknown, max = MAX_TEXT): v is string => typeof v === "string" && v.length > 0 && v.length <= max && placeholdersOk(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const safeHref = (h: string) => /^(\/(?!\/)|https:\/\/|mailto:|tel:)/.test(h);

function spanOk(s: unknown): s is Span {
  if (!isObj(s)) return false;
  if (Object.keys(s).some((k) => !["text", "href", "em", "strong"].includes(k))) return false;
  if (typeof s.text !== "string" || s.text.length === 0 || s.text.length > MAX_TEXT || !placeholdersOk(s.text)) return false;
  if (s.href !== undefined && !(typeof s.href === "string" && placeholdersOk(s.href) && safeHref(s.href))) return false;
  if (s.em !== undefined && s.em !== true) return false;
  if (s.strong !== undefined && s.strong !== true) return false;
  return true;
}
const spansOk = (v: unknown): v is Span[] => Array.isArray(v) && v.length > 0 && v.length <= 200 && v.every(spanOk);

function blockOk(b: unknown): b is Block {
  if (!isObj(b) || typeof b.t !== "string") return false;
  const keys = Object.keys(b);
  const only = (...allowed: string[]) => keys.every((k) => allowed.includes(k));
  switch (b.t) {
    case "h2": return only("t", "text") && isStr(b.text, 300);
    case "p": return only("t", "spans", "lang") && spansOk(b.spans) && (b.lang === undefined || (typeof b.lang === "string" && /^[a-z]{2,3}$/.test(b.lang)));
    case "note": return only("t", "spans") && spansOk(b.spans);
    case "ul":
    case "ol": return only("t", "items") && Array.isArray(b.items) && b.items.length > 0 && b.items.length <= 100 && b.items.every(spansOk);
    case "links": return only("t", "items") && Array.isArray(b.items) && b.items.length > 0 && b.items.length <= 50
      && b.items.every((i) => isObj(i) && Object.keys(i).every((k) => ["href", "title", "text"].includes(k)) && typeof i.href === "string" && safeHref(i.href) && isStr(i.title, 200) && isStr(i.text, 500));
    default: return false;
  }
}

/** Returns an error string, or null when `blocks` is a valid body. */
export function validateBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return "body_must_be_array";
  if (blocks.length === 0) return "body_empty";
  if (blocks.length > MAX_BLOCKS) return "body_too_long";
  for (let i = 0; i < blocks.length; i++) if (!blockOk(blocks[i])) return `bad_block_${i}`;
  return null;
}

export function validateRelated(related: unknown): string | null {
  if (!Array.isArray(related) || related.length > 12) return "bad_related";
  for (const r of related) {
    if (!isObj(r) || Object.keys(r).some((k) => k !== "href" && k !== "label")) return "bad_related";
    if (typeof r.href !== "string" || !r.href.startsWith("/") || r.href.startsWith("//") || !isStr(r.label, 120)) return "bad_related";
  }
  return null;
}

const mapSpans = (spans: Span[]): Span[] => spans.map((s) => ({ ...s, text: resolvePlaceholders(s.text), ...(s.href ? { href: resolvePlaceholders(s.href) } : {}) }));

export function resolveBlocks(blocks: Block[]): Block[] {
  return blocks.map((b): Block => {
    switch (b.t) {
      case "h2": return { ...b, text: resolvePlaceholders(b.text) };
      case "p":
      case "note": return { ...b, spans: mapSpans(b.spans) };
      case "ul":
      case "ol": return { ...b, items: b.items.map(mapSpans) };
      case "links": return { ...b, items: b.items.map((i) => ({ href: i.href, title: resolvePlaceholders(i.title), text: resolvePlaceholders(i.text) })) };
    }
  });
}
