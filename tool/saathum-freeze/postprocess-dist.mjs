#!/usr/bin/env node
// [SAATHUM-FREEZE-1] Runs AFTER `astro build` on source prepared by
// prepare-source.mjs. It rewrites the BUILT html so no page source is redesigned:
//
//  1. <meta name="robots" content="noindex"> on every page (replacing whatever the
//     page asked for) and <link rel="canonical"> pointing at NEW_ORIGIN + the same path.
//     og:url follows; the sitemap <link> and all JSON-LD are removed.
//  2. A thin banner at the very top of <body>: "<old brand> is now at <new brand>",
//     the link going to NEW_ORIGIN + the same path. Wording: freeze-config.mjs.
//  3. Links to routes that are not in this archive: if the route is one the new site
//     serves (REDIRECT_PREFIXES) the href becomes NEW_ORIGIN + path; any other dead
//     link becomes an inert <span>.
//  4. Any leftover Clerk / Turnstile script or preconnect tag is removed.
//
// Usage: node postprocess-dist.mjs <path-to-dist-dir> [--new-origin=https://...]

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import {
  BANNER_FONT_SIZE_PX,
  BANNER_TEMPLATE,
  isRedirectedPath,
  loadOldBrandName,
  resolveNewBrandName,
  resolveNewOrigin,
} from './freeze-config.mjs';

export const NOINDEX_META = '<meta name="robots" content="noindex">';
export const BANNER_ID = 'frozen-banner';

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** URL path a built file is served at: dist/x/index.html -> /x, dist/index.html -> /. */
export function urlPathForFile(distDir, file) {
  const rel = relative(distDir, file).split(sep).join('/');
  if (rel === '404.html') return '/'; // a not-found page has no path of its own
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'/index.html'.length);
  return '/' + rel.replace(/\.html$/, '');
}

export const canonicalUrl = (newOrigin, path) => `${newOrigin}${path === '/' ? '/' : path}`;

// --- 1. robots + canonical ----------------------------------------------------
export function applyNoindexAndCanonical(html, canonical) {
  const head = (s) => (s.includes('</head>') ? s : null);
  if (!head(html)) return html;
  html = html.replace(/<meta\s+name="robots"[^>]*>\s*/gi, '');
  html = html.replace(/<link\b[^>]*\brel="canonical"[^>]*>\s*/gi, '');
  html = html.replace(/<link\b[^>]*\brel="sitemap"[^>]*>\s*/gi, '');
  html = html.replace(/<script\b[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>\s*/gi, '');
  html = html.replace(/(<meta\s+property="og:url"\s+content=")[^"]*(")/gi, `$1${escapeHtml(canonical)}$2`);
  return html.replace(
    '</head>',
    `  ${NOINDEX_META}\n  <link rel="canonical" href="${escapeHtml(canonical)}">\n</head>`,
  );
}

// --- 2. banner -------------------------------------------------------------------
export function bannerHtml({ oldBrand, newBrand, href }) {
  const link = `<a href="${escapeHtml(href)}" style="color:#8a1f17;font-weight:700;text-decoration:underline">${escapeHtml(newBrand)}</a>`;
  const text = BANNER_TEMPLATE.replace('{old}', escapeHtml(oldBrand)).replace('{link}', link);
  return (
    `<div id="${BANNER_ID}" role="note" style="box-sizing:border-box;width:100%;margin:0;padding:10px 16px;` +
    `background:#fff3cd;color:#2b1a12;border-bottom:1px solid #e0c36a;text-align:center;` +
    `font:400 ${BANNER_FONT_SIZE_PX}px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif">${text}</div>`
  );
}

export function injectBanner(html, banner) {
  if (html.includes(`id="${BANNER_ID}"`)) return html;
  const body = html.match(/<body\b[^>]*>/i);
  if (!body) return html;
  const at = body.index + body[0].length;
  return html.slice(0, at) + '\n' + banner + html.slice(at);
}

// --- 3. links ----------------------------------------------------------------------
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
export function rewriteLinks(html, hasPath, newOrigin) {
  const openTagRe = /<a\s[^>]*>/gi;
  let out = '';
  let i = 0;
  let toNew = 0;
  let disabled = 0;
  let match;
  while ((match = openTagRe.exec(html))) {
    const openTag = match[0];
    const hrefMatch = openTag.match(/\shref="(\/(?!\/)[^"]*)"/i);
    if (!hrefMatch) continue;
    const href = hrefMatch[1].replaceAll('&amp;', '&');
    if (href.startsWith('/cdn-cgi/') || hasPath(href)) continue; // /cdn-cgi/* is the zone's image resizer
    if (isRedirectedPath(href)) {
      out += html.slice(i, match.index) + openTag.replace(hrefMatch[0], ` href="${escapeHtml(newOrigin + href)}"`);
      i = openTagRe.lastIndex;
      toNew++;
      continue;
    }
    const closeIdx = html.indexOf('</a>', openTagRe.lastIndex);
    if (closeIdx === -1) continue;
    out += html.slice(i, match.index) + `<span class="frozen-disabled-link">${html.slice(openTagRe.lastIndex, closeIdx)}</span>`;
    i = closeIdx + '</a>'.length;
    openTagRe.lastIndex = i;
    disabled++;
  }
  out += html.slice(i);
  return { html: out, toNew, disabled };
}

// --- 4. third-party leftovers ---------------------------------------------------------
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

export function processHtml(html, { path, newOrigin, oldBrand, newBrand, hasPath }) {
  const canonical = canonicalUrl(newOrigin, path);
  const third = stripThirdParty(html);
  const links = rewriteLinks(third.html, hasPath, newOrigin);
  let out = applyNoindexAndCanonical(links.html, canonical);
  out = injectBanner(out, bannerHtml({ oldBrand, newBrand, href: canonical }));
  return { html: out, toNew: links.toNew, disabled: links.disabled };
}

if (process.argv[1] && process.argv[1].endsWith('postprocess-dist.mjs')) {
  const distDir = process.argv[2];
  if (!distDir || distDir.startsWith('--') || !existsSync(distDir)) {
    console.error('Usage: node postprocess-dist.mjs <path-to-dist-dir> [--new-origin=https://...]');
    process.exit(1);
  }
  const newOrigin = resolveNewOrigin();
  const oldBrand = loadOldBrandName();
  const newBrand = resolveNewBrandName();
  const hasPath = distHasPath(distDir);
  const files = walk(distDir);
  let toNew = 0;
  let disabled = 0;
  for (const file of files) {
    const res = processHtml(readFileSync(file, 'utf8'), {
      path: urlPathForFile(distDir, file),
      newOrigin,
      oldBrand,
      newBrand,
      hasPath,
    });
    toNew += res.toNew;
    disabled += res.disabled;
    writeFileSync(file, res.html);
  }
  console.log(
    `[saathum-freeze] postprocessed ${files.length} HTML files -> ${newOrigin}: noindex + canonical + banner on each; ` +
      `${toNew} links repointed to the new origin, ${disabled} dead links made inert.`,
  );
}
