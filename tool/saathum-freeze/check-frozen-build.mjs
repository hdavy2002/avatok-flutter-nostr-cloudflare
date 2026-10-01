#!/usr/bin/env node
// [SAATHUM-FREEZE-1] Post-build check for the frozen saathum.com archive's dist/.
// Deliberately NOT web/scripts/check-homepage.mjs: that script asserts the opposite of
// what this build wants (no noindex, live sign-up links). Run AFTER postprocess-dist.mjs.
//
// Usage: node check-frozen-build.mjs <path-to-dist-dir> [--new-origin=https://...]

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import {
  BANNER_FONT_SIZE_PX,
  KEEP_PAGES,
  REDIRECT_LIMITS,
  REDIRECT_PREFIXES,
  functionalRedirectRules,
  isDynamicRule,
  loadBrand,
  loadOldBrandName,
  resolveNewBrandName,
  resolveNewOrigin,
} from './freeze-config.mjs';
import { BANNER_ID, distHasPath, urlPathForFile } from './postprocess-dist.mjs';

const distDir = process.argv[2];
if (!distDir || distDir.startsWith('--') || !existsSync(distDir)) {
  console.error('Usage: node check-frozen-build.mjs <path-to-dist-dir> [--new-origin=https://...]');
  process.exit(1);
}
const newOrigin = resolveNewOrigin();
const newBrand = resolveNewBrandName();
const oldBrand = loadOldBrandName();
const brand = loadBrand();

let failures = 0;
function check(cond, message) {
  if (!cond) {
    failures++;
    console.error(`[FAIL] ${message}`);
  } else {
    console.log(`[ok]   ${message}`);
  }
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, files);
    else files.push(p);
  }
  return files;
}
const allFiles = walk(distDir);
const rel = (f) => relative(distDir, f).split(sep).join('/');
const htmlFiles = allFiles.filter((f) => extname(f) === '.html');

// 1. Pages that must exist, routes that must not.
const MUST_EXIST = [
  'index.html', '404.html', 'about/index.html', 'how-it-works/index.html', 'temples/index.html',
  'rituals/index.html', 'help/index.html', 'help/search.json', 'contact/index.html', 'terms/index.html',
  'privacy/index.html', 'refunds/index.html', 'cookies/index.html', 'disclaimer/index.html', 'grievance/index.html',
];
for (const f of MUST_EXIST) check(existsSync(join(distDir, f)), `dist/${f} exists (kept page)`);
check(htmlFiles.some((f) => /^rituals\/[^/]+\/index\.html$/.test(rel(f))), 'at least one /rituals/<article> was built');
check(htmlFiles.some((f) => /^help\/.+\/index\.html$/.test(rel(f))), 'at least one /help/<article> was built');
check(KEEP_PAGES.length > 0, `kept-page list has ${KEEP_PAGES.length} entries`);

// Every functional route + every other SSR/API route family must have no HTML page.
const DELETED_ROUTES = [...REDIRECT_PREFIXES, 'api', 'blog', 'careers', 'test', 'embed', 'vision', 'pay', 'agent', 'india', '[username]'];
for (const dir of DELETED_ROUTES) {
  const page = htmlFiles.filter((f) => rel(f) === `${dir}.html` || rel(f).startsWith(`${dir}/`));
  check(page.length === 0, `no HTML page under /${dir} (deleted route stayed deleted)`);
}
check(!existsSync(join(distDir, '_worker.js')) && !existsSync(join(distDir, '_routes.json')), 'no _worker.js / _routes.json (plain static deploy)');

// 2. Crawler files.
const robotsPath = join(distDir, 'robots.txt');
check(existsSync(robotsPath) && /^Disallow:\s*\/\s*$/m.test(readFileSync(robotsPath, 'utf8')), 'robots.txt disallows all crawling');
const crawlerFiles = allFiles.map(rel).filter((f) => /^(llms.*\.txt|sitemap.*\.xml|[a-f0-9]{32}\.txt)$/.test(f));
check(crawlerFiles.length === 0, `no llms*.txt / sitemap*.xml / IndexNow key file${crawlerFiles.length ? ` (found: ${crawlerFiles.join(', ')})` : ''}`);

// 3. Every HTML page: noindex, canonical, banner.
let bad = 0;
const bump = (f, why) => {
  bad++;
  console.error(`[FAIL] ${rel(f)}: ${why}`);
  failures++;
};
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const path = urlPathForFile(distDir, file);
  const expected = `${newOrigin}${path}`;
  const robots = [...html.matchAll(/<meta\s+name="robots"[^>]*>/gi)].map((m) => m[0]);
  if (robots.length !== 1 || !/content="noindex"/i.test(robots[0])) bump(file, `robots meta must be exactly one noindex tag (found ${robots.length})`);
  const canon = [...html.matchAll(/<link\b[^>]*\brel="canonical"[^>]*>/gi)].map((m) => m[0]);
  if (canon.length !== 1 || !canon[0].includes(`href="${expected}"`)) bump(file, `canonical must be ${expected} (found ${canon.join(' ') || 'none'})`);
  const banner = html.match(new RegExp(`<div id="${BANNER_ID}"[^>]*>([\\s\\S]*?)</div>`));
  if (!banner) bump(file, 'banner missing');
  else {
    if (!banner[1].includes(oldBrand) || !banner[1].includes(`>${newBrand}</a>`) || !banner[1].includes(`href="${expected}"`)) {
      bump(file, 'banner must name the old brand and link the new brand to the same path on the new origin');
    }
    const size = Number(/font:[^;"]*?(\d+(?:\.\d+)?)px/.exec(banner[0])?.[1]);
    if (!(size >= 14) || size !== BANNER_FONT_SIZE_PX) bump(file, `banner font size must be ${BANNER_FONT_SIZE_PX}px (>= 14), found ${size}`);
    if (!/<body\b[^>]*>\s*<div id="frozen-banner"/i.test(html)) bump(file, 'banner is not the first element in <body>');
  }
  if (/application\/ld\+json/i.test(html)) bump(file, 'JSON-LD structured data survived');
}
check(bad === 0, `all ${htmlFiles.length} HTML pages carry noindex + canonical + banner`);

// 4. Internal links: nothing points at a path that is not in dist.
const hasPath = distHasPath(distDir);
let brokenLinks = 0;
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/<a\s[^>]*?\shref="(\/(?!\/)[^"]*)"/gi)) {
    const href = m[1].replaceAll('&amp;', '&');
    if (href.startsWith('/cdn-cgi/') || hasPath(href)) continue;
    brokenLinks++;
    console.error(`[FAIL] ${rel(file)}: link to ${href} (not in this archive, not repointed)`);
  }
}
check(brokenLinks === 0, 'no internal link points at a deleted route');
failures += brokenLinks;

// 5. Forbidden references in ANY text file of the build.
const FORBIDDEN = [
  [new RegExp(brand.hosts.api.replaceAll('.', '\\.'), 'i'), `API host ${brand.hosts.api}`],
  [new RegExp(brand.hosts.auth.replaceAll('.', '\\.'), 'i'), `auth host ${brand.hosts.auth}`],
  [/clerk/i, 'Clerk'],
  [/turnstile|challenges\.cloudflare\.com/i, 'Turnstile'],
  [/\bpreeti\b/i, 'Preeti chat widget'],
];
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.txt', '.xml', '.webmanifest', '.map', '.svg', '']);
let hits = 0;
for (const file of allFiles) {
  if (!TEXT_EXT.has(extname(file)) || rel(file).startsWith('_images/')) continue;
  const text = readFileSync(file, 'utf8');
  for (const [re, label] of FORBIDDEN) {
    if (re.test(text)) {
      hits++;
      console.error(`[FAIL] ${rel(file)} references ${label}`);
    }
  }
}
check(hits === 0, 'no built file references the API host, Clerk, Turnstile or the Preeti widget');
failures += hits;

// 6. _redirects carries the functional rules and stays inside Cloudflare's limits.
const redirectsPath = join(distDir, '_redirects');
check(existsSync(redirectsPath), 'dist/_redirects exists');
if (existsSync(redirectsPath)) {
  const lines = readFileSync(redirectsPath, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const rules = lines.map((l) => l.split(/\s+/));
  const { statics, dynamics } = functionalRedirectRules(newOrigin);
  let missing = 0;
  for (const [src, dest] of [...statics, ...dynamics]) {
    if (!rules.some((r) => r[0] === src && r[1] === dest && (r[2] ?? '302') === '301')) {
      missing++;
      console.error(`[FAIL] _redirects is missing: ${src} ${dest} 301`);
    }
  }
  check(missing === 0, `_redirects has all ${statics.length + dynamics.length} functional rules (301 -> ${newOrigin})`);
  failures += missing;
  for (const must of ['/j/*', '/l/*', '/book/*', '/checkout/*', '/dashboard/*', '/sign-in/*', '/sign-up/*', '/sso-callback/*', '/watch/*', '/shop/*', '/explore/*', '/marketplace/*', '/admin/*', '/live/*', '/session/*', '/c/*', '/saathum/*', '/e/*']) {
    check(rules.some((r) => r[0] === must && r[1] === `${newOrigin}${must.replace('*', ':splat')}`), `_redirects: ${must} -> ${newOrigin}${must.replace('*', ':splat')}`);
  }
  const nDyn = rules.filter((r) => isDynamicRule(r[0])).length;
  const nStat = rules.length - nDyn;
  check(nDyn <= REDIRECT_LIMITS.dynamic && nStat <= REDIRECT_LIMITS.static, `_redirects within Pages limits (${nStat}/${REDIRECT_LIMITS.static} static, ${nDyn}/${REDIRECT_LIMITS.dynamic} dynamic)`);
  // Static rules must precede dynamic ones.
  const firstDyn = rules.findIndex((r) => isDynamicRule(r[0]));
  check(firstDyn === -1 || rules.slice(firstDyn).every((r) => isDynamicRule(r[0])), '_redirects lists static rules before dynamic rules');
  // No redirect may point at a deleted route on THIS host.
  const localDead = rules.filter((r) => r[1].startsWith('/') && !hasPath(r[1]));
  check(localDead.length === 0, `_redirects has no rule whose local target is missing${localDead.length ? ` (${localDead.map((r) => r.join(' ')).join('; ')})` : ''}`);
}

console.log(`\n[saathum-freeze] check-frozen-build: ${htmlFiles.length} HTML files scanned, ${failures} failure(s).`);
if (failures > 0) process.exit(1);
