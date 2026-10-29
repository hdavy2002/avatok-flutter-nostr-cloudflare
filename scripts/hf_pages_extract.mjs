#!/usr/bin/env node
// [HF-PAGES-1] One-off converter: web/src/pages/<policy>.astro -> site_pages seed SQL.
//   node scripts/hf_pages_extract.mjs            writes worker/migrations/2026-10-29-hf-site-pages-seed.sql
//   node scripts/hf_pages_extract.mjs --dump terms   prints that page's blocks as JSON (spot check)
// Text is copied verbatim (whitespace collapsed like HTML does). Placeholders:
//   {BRAND.x.y} -> {brand.x.y}, {BUSINESS_CONTACT.x} -> {business.x}, mailto:${BRAND.emails.x} -> mailto:{brand.emails.x}
// Block shapes: h2 | p (+lang) | ul | ol | note | links (safety-centre cards). Dropped (web-only): <script>, <style>, empty <p>.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLUGS = ['terms', 'privacy', 'refunds', 'wallet-terms', 'community-guidelines', 'disclaimer', 'rules-of-engagement',
  'grievance', 'safety', 'cookies', 'data-deletion', 'age-policy', 'child-safety', 'intermediary-policy'];

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…', rarr: '→', larr: '←', times: '×', middot: '·', bull: '•', copy: '©', rupee: '₹' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e] ?? m;
});

const problems = [];
const ph = (s, slug) => s
  .replace(/\{\s*BRAND\.([A-Za-z.]+)\s*\}/g, (_, p) => `{brand.${p}}`)
  .replace(/\{\s*BUSINESS_CONTACT\.([A-Za-z]+)\s*\}/g, (_, p) => `{business.${p}}`);

// Find the matching close of a { ... } JSX expression starting at index i (s[i] === '{').
function braceEnd(s, i) {
  let d = 0, q = null;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (q) { if (c === '\\') k++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') d++;
    else if (c === '}' && --d === 0) return k;
  }
  throw new Error('unbalanced {');
}

// Open tag of HelloFraandsPage: returns { attrs: string, end: index after '>' }
function pageTag(src) {
  const start = src.indexOf('<HelloFraandsPage');
  let i = start + '<HelloFraandsPage'.length;
  while (i < src.length) {
    if (src[i] === '{') i = braceEnd(src, i) + 1;
    else if (src[i] === '"' || src[i] === "'") { const q = src[i]; i = src.indexOf(q, i + 1) + 1; }
    else if (src[i] === '>') return { attrs: src.slice(start + '<HelloFraandsPage'.length, i), end: i + 1 };
    else i++;
  }
  throw new Error('page tag not closed');
}
function attr(attrs, name) {
  const re = new RegExp(`(?:^|\\s)${name}=`);
  const m = re.exec(attrs);
  if (!m) return undefined;
  let i = m.index + m[0].length;
  if (attrs[i] === '"') return attrs.slice(i + 1, attrs.indexOf('"', i + 1));
  if (attrs[i] === '{') return (0, eval)('(' + attrs.slice(i + 1, braceEnd(attrs, i)) + ')'); // trusted repo source
  throw new Error('attr ' + name);
}

function convert(slug) {
  const src = readFileSync(join(root, 'web/src/pages', slug + '.astro'), 'utf8');
  const { attrs, end } = pageTag(src);
  const title = attr(attrs, 'title'), summary = attr(attrs, 'summary'), updated = attr(attrs, 'updated');
  const related = attr(attrs, 'related') ?? [];
  let body = src.slice(end, src.lastIndexOf('</HelloFraandsPage>'));
  body = body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

  const blocks = [];
  let cur = null;          // {kind:'h2'|'p'|'li', spans:[]}
  let list = null;         // {t:'ul'|'ol', items:[]}
  let cards = null;        // safety-centre cards
  let card = null, cardField = null;
  let strong = 0, em = 0, href = null, lang = null;

  const push = (text) => {
    if (!text) return;
    if (cardField) { card[cardField] = (card[cardField] ?? '') + text; return; }
    if (!cur) { if (text.trim()) problems.push(`${slug}: stray text outside block: ${JSON.stringify(text.slice(0, 60))}`); return; }
    const span = { text };
    if (href) span.href = href;
    if (em) span.em = true;
    if (strong) span.strong = true;
    cur.spans.push(span);
  };
  const clean = (spans) => {
    // merge neighbours with identical formatting, collapse whitespace, trim block edges
    const out = [];
    for (const s of spans) {
      const t = { ...s, text: s.text === '\n' ? '\n' : s.text.replace(/\s+/g, ' ') };
      const p = out[out.length - 1];
      if (p && p.text !== '\n' && t.text !== '\n' && p.href === t.href && !!p.em === !!t.em && !!p.strong === !!t.strong) p.text += t.text;
      else out.push(t);
    }
    // whitespace around <br>
    for (let i = 0; i < out.length; i++) if (out[i].text === '\n') {
      if (out[i - 1] && out[i - 1].text !== '\n') out[i - 1].text = out[i - 1].text.replace(/\s+$/, '');
      if (out[i + 1] && out[i + 1].text !== '\n') out[i + 1].text = out[i + 1].text.replace(/^\s+/, '');
    }
    if (out[0]) out[0].text = out[0].text.replace(/^\s+/, '');
    if (out.length) out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
    return out.filter((s) => s.text !== '');
  };
  const closeCur = () => {
    if (!cur) return;
    const spans = clean(cur.spans);
    if (cur.kind === 'h2') blocks.push({ t: 'h2', text: spans.map((s) => s.text).join('') });
    else if (cur.kind === 'p') {
      if (!spans.length) problems.push(`${slug}: dropped empty <p>`);
      else blocks.push({ t: 'p', ...(cur.lang ? { lang: cur.lang } : {}), spans });
    } else if (cur.kind === 'li') list.items.push(spans);
    cur = null; href = null; strong = 0; em = 0;
  };

  const tokRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>{]|\{[^}]*\})*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = tokRe.exec(body))) {
    if (m[5] !== undefined) { push(ph(decode(m[5]), slug)); continue; }
    const [, closing, tag0, tattrs, selfClose] = m;
    const tag = tag0.toLowerCase();
    if (!closing) {
      if (tag === 'h2') { closeCur(); cur = { kind: 'h2', spans: [] }; }
      else if (tag === 'p') { closeCur(); cur = { kind: 'p', spans: [], lang: /lang="([^"]+)"/.exec(tattrs)?.[1] }; }
      else if (tag === 'ul' || tag === 'ol') { closeCur(); list = { t: tag, items: [] }; }
      else if (tag === 'li') { closeCur(); cur = { kind: 'li', spans: [] }; }
      else if (tag === 'div' && /safety-cards/.test(tattrs)) { closeCur(); cards = { t: 'links', items: [] }; }
      else if (tag === 'a') {
        let h = /href=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(tattrs);
        if (!h) problems.push(`${slug}: <a> without parsable href: ${tattrs}`);
        else if (cards) { card = { href: h[1] }; }
        else href = ph((h[1] ?? h[2]).replace(/\$\{\s*BRAND\.([A-Za-z.]+)\s*\}/g, '{BRAND.$1}'), slug);
      }
      else if (tag === 'strong') { if (cards) cardField = 'title'; else strong++; }
      else if (tag === 'span' && cards) cardField = 'text';
      else if (tag === 'em') em++;
      else if (tag === 'br') push('\n');
      else problems.push(`${slug}: unhandled tag <${tag}>`);
    } else {
      if (tag === 'h2' || tag === 'p' || tag === 'li') closeCur();
      else if (tag === 'ul' || tag === 'ol') { closeCur(); blocks.push(list); list = null; }
      else if (tag === 'div' && cards) { blocks.push(cards); cards = null; }
      else if (tag === 'a') { if (cards) { cards.items.push(card); card = null; } else href = null; }
      else if (tag === 'strong') { if (cards) cardField = null; else strong = Math.max(0, strong - 1); }
      else if (tag === 'span') cardField = null;
      else if (tag === 'em') em = Math.max(0, em - 1);
    }
  }
  closeCur();

  // Any JSX expression we did not translate must not survive.
  const strings = [];
  (function walk(v) { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); })(blocks);
  const leftover = strings.join('\u0001').match(/\{(?!brand\.|business\.)[^}]*\}|\$\{|BRAND\.|BUSINESS_CONTACT/g);
  if (leftover) problems.push(`${slug}: untranslated expression(s): ${[...new Set(leftover)].join(' | ')}`);
  return { slug, title, summary, updated, related, blocks };
}

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const pages = SLUGS.map(convert);
const dump = process.argv.indexOf('--dump');
if (dump > -1) {
  const p = pages.find((x) => x.slug === process.argv[dump + 1]);
  console.log(JSON.stringify(p, null, 1));
  if (problems.length) console.error('PROBLEMS:\n' + problems.join('\n'));
  process.exit(0);
}
const lines = [
  '-- [HF-PAGES-1] Seed: the 14 policy pages, converted verbatim from web/src/pages/*.astro by scripts/hf_pages_extract.mjs.',
  '-- INSERT OR IGNORE: re-running this never overwrites a page an admin has edited since.',
  '-- Placeholders ({brand.name}, {business.postalAddress} ...) are resolved by the API, not stored resolved.',
];
for (const p of pages) {
  lines.push(`INSERT OR IGNORE INTO site_pages (slug,title,summary,related,body,version,updated_at,published,updated_by) VALUES (${q(p.slug)},${q(p.title)},${q(p.summary)},${q(JSON.stringify(p.related))},${q(JSON.stringify(p.blocks))},1,${q(p.updated)},1,'seed');`);
}
const out = join(root, 'worker/migrations/2026-10-29-hf-site-pages-seed.sql');
writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${out}: ${pages.length} pages, ${pages.reduce((n, p) => n + p.blocks.length, 0)} blocks`);
for (const p of pages) console.log(`  ${p.slug}: ${p.blocks.length} blocks, updated ${p.updated}, related ${p.related.length}`);
if (problems.length) console.log('NOTES / PROBLEMS:\n' + problems.join('\n'));
