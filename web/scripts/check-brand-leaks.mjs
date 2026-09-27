// [WEB-SEO-REBRAND-1 2026-09-27] OWNER DECISION: no public saathum.com page may
// show the pre-rebrand identity. Fails the web deploy if any INDEXABLE built page
// (robots "index"), the sitemap or llms.txt shows one of the banned words in its
// VISIBLE text or its SEO metadata (title, description, JSON-LD).
//
// Code identifiers such as data-avatok-auth or window.AvatokHost live in scripts
// and attributes and are deliberately NOT scanned here — renaming those needs an
// app build (see the SEO rebrand plan, phase 5).
//
// When this fails: fix the page copy. Do not add an allowlist.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const root = resolve('dist');
const BANNED = /\b(avatok|ava\s*tok|ava\s*global|avaglobal|ave\s*maria|delaware|newark)\b/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

const failures = [];
function scan(label, text) {
  const m = text.match(BANNED);
  if (m) {
    const i = Math.max(0, m.index - 60);
    failures.push(`${label}: "…${text.slice(i, m.index + 60).replace(/\s+/g, ' ')}…"`);
  }
}

for (const file of walk(root)) {
  const html = readFileSync(file, 'utf8');
  const robots = html.match(/<meta name="robots" content="([^"]*)"/i)?.[1] ?? '';
  if (!/\bindex\b/i.test(robots) || /\bnoindex\b/i.test(robots)) continue;
  const rel = '/' + relative(root, file).replace(/index\.html$/, '');
  const meta = [
    html.match(/<title[^>]*>([^<]*)/i)?.[1] ?? '',
    html.match(/<meta name="description" content="([^"]*)"/i)?.[1] ?? '',
    ...[...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]),
  ].join(' ');
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  scan(rel + ' (metadata)', meta);
  scan(rel + ' (visible text)', visible);
}
for (const f of ['llms.txt', 'llms-rituals.txt', 'sitemap-pages.xml', 'robots.txt']) {
  const p = join(root, f);
  if (existsSync(p)) scan('/' + f, readFileSync(p, 'utf8'));
}

if (failures.length) {
  console.error('Brand-leak check FAILED — the old identity is visible on public pages:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('Brand-leak check passed: no old-brand words on indexable pages, sitemap or llms.txt.');
