#!/usr/bin/env node
// [SAATHUM-FREEZE-1] Runs AFTER `astro build` on source prepared by
// prepare-source.mjs. It rewrites the BUILT html so no page source is redesigned:
//
//  1. <meta name="robots" content="noindex"> on every page (replacing whatever the page
//     asked for). Canonical links, the sitemap <link> and all JSON-LD are REMOVED, and no
//     tag anywhere points at another site (owner decision 2026-10-01: no trace of the new site).
//  2. Links to routes that are not in this archive become an inert <span> with the same text.
//  3. Any leftover Clerk / Turnstile script or preconnect tag is removed.
//
// Usage: node postprocess-dist.mjs <path-to-dist-dir> 

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

export const NOINDEX_META = '<meta name="robots" content="noindex">';

/** URL path a built file is served at: dist/x/index.html -> /x, dist/index.html -> /. */
export function urlPathForFile(distDir, file) {
  const rel = relative(distDir, file).split(sep).join('/');
  if (rel === '404.html') return '/'; // a not-found page has no path of its own
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'/index.html'.length);
  return '/' + rel.replace(/\.html$/, '');
}

// --- 1. robots, canonical removal ---------------------------------------------
export function applyNoindex(html) {
  if (!html.includes('</head>')) return html;
  html = html.replace(/<meta\s+name="robots"[^>]*>\s*/gi, '');
  html = html.replace(/<link\b[^>]*\brel="canonical"[^>]*>\s*/gi, '');
  html = html.replace(/<link\b[^>]*\brel="sitemap"[^>]*>\s*/gi, '');
  html = html.replace(/<script\b[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>\s*/gi, '');
  return html.replace('</head>', `  ${NOINDEX_META}\n</head>`);
}

// --- 2. links ----------------------------------------------------------------------
/** Build an "is this path a file/page in dist?" function. */
export function distHasPath(distDir) {
  return (urlPath) => {
    let p = urlPath.split('#')[0].split('?')[0];
    try {
      p = decodeURI(p);
    } catch {
      /* keep raw */
    }
    const base = join(distDir, p);
    if (existsSync(base) && statSync(base).isFile()) return true;
    if (existsSync(join(base, 'index.html'))) return true;
    return existsSync(base + '.html');
  };
}

// Anchors never nest in valid HTML, so the first </a> after an opening tag is its own.
export function rewriteLinks(html, hasPath) {
  const openTagRe = /<a\s[^>]*>/gi;
  let out = '';
  let i = 0;
  let disabled = 0;
  let match;
  while ((match = openTagRe.exec(html))) {
    const openTag = match[0];
    const hrefMatch = openTag.match(/\shref="(\/(?!\/)[^"]*)"/i);
    if (!hrefMatch) continue;
    const href = hrefMatch[1].replaceAll('&amp;', '&');
    if (href.startsWith('/cdn-cgi/') || hasPath(href)) continue; // /cdn-cgi/* is the zone's image resizer
    const closeIdx = html.indexOf('</a>', openTagRe.lastIndex);
    if (closeIdx === -1) continue;
    out += html.slice(i, match.index) + `<span class="frozen-disabled-link">${html.slice(openTagRe.lastIndex, closeIdx)}</span>`;
    i = closeIdx + '</a>'.length;
    openTagRe.lastIndex = i;
    disabled++;
  }
  out += html.slice(i);
  return { html: out, disabled };
}

// --- 3. third-party leftovers ---------------------------------------------------------
export function stripThirdParty(html) {
  const before = html;
  html = html.replace(/<script\b[^>]*\bsrc="[^"]*(?:clerk|turnstile|challenges\.cloudflare\.com)[^"]*"[^>]*>\s*<\/script>\s*/gi, '');
  html = html.replace(/<link\b[^>]*\bhref="[^"]*(?:clerk|api\.[a-z0-9-]+\.[a-z]{2,})[^"]*"[^>]*>\s*/gi, '');
  return { html, changed: html !== before };
}

// --- driver --------------------------------------------------------------------------------
function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, files);
    else if (extname(name) === '.html') files.push(p);
  }
  return files;
}

export function processHtml(html, { hasPath }) {
  const third = stripThirdParty(html);
  const links = rewriteLinks(third.html, hasPath);
  return { html: applyNoindex(links.html), disabled: links.disabled };
}

if (process.argv[1] && process.argv[1].endsWith('postprocess-dist.mjs')) {
  const distDir = process.argv[2];
  if (!distDir || distDir.startsWith('--') || !existsSync(distDir)) {
    console.error('Usage: node postprocess-dist.mjs <path-to-dist-dir> ');
    process.exit(1);
  }
  const hasPath = distHasPath(distDir);
  const files = walk(distDir);
  let disabled = 0;
  for (const file of files) {
    const res = processHtml(readFileSync(file, 'utf8'), { hasPath });
    disabled += res.disabled;
    writeFileSync(file, res.html);
  }
  console.log(`[saathum-freeze] postprocessed ${files.length} HTML files: noindex on each, canonical removed; ${disabled} dead links made inert.`);
}
