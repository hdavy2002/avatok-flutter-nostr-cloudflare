#!/usr/bin/env node
// [06-FREEZE-AVATOK] Runs AFTER `astro build` on source already prepared by
// prepare-source.mjs. Two jobs:
//
//  1. Belt-and-suspenders noindex: insert
//     <meta name="robots" content="noindex, nofollow"> into any page that
//     doesn't already have one (every page should, via Base.astro's forced
//     `noindex`, but this is a second, independent check on the actual
//     built output rather than trusting the source patch alone).
//
//  2. Neutralize dead CTAs: SiteHeader / SiteFooter / GlobalHeader /
//     GlobalFooter / ListingDetailsComp / the india-preview/* components and
//     several blog posts all hardcode links to routes that prepare-source.mjs
//     deletes (/sign-in, /sign-up, /sign-out, /dashboard, /marketplace,
//     /explore, /india, ...). None of that is reachable through a per-page
//     prop, so this rewrites the BUILT html directly: any <a> whose href
//     starts with a dead route becomes an inert <span> with the same visible
//     text, instead of a link that 404s.
//
// Usage: node postprocess-dist.mjs <path-to-dist-dir>

import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';

// Route prefixes with no page behind them any more (see prepare-source.mjs's
// EXCLUDE list). Matched as href="<prefix>" followed by end-of-string, '/',
// '?' or '#' — so '/india' does not also swallow '/india-next', '/pay'
// doesn't swallow '/payouts', '/consult' doesn't swallow
// '/consultation-terms', '/marketplace' doesn't swallow '/marketplace-terms'.
const DEAD_PREFIXES = [
  '/sign-in', '/sign-up', '/sign-out', '/sso-callback', '/forgot-password',
  '/dashboard', '/admin', '/vision', '/marketplace', '/explore', '/india',
  '/pay', '/consult', '/session', '/talk', '/watch', '/book', '/agent',
  '/embed', '/test', '/l', '/c', '/e', '/j',
];

export function isDeadHref(href) {
  const clean = href.replaceAll('&amp;', '&');
  if (!clean.startsWith('/')) return false; // leave external/mailto/tel/anchor links alone
  return DEAD_PREFIXES.some((prefix) => {
    if (!clean.startsWith(prefix)) return false;
    const next = clean[prefix.length];
    return next === undefined || next === '/' || next === '?' || next === '#';
  });
}

// Anchors never nest in valid HTML, so the first </a> after a matched
// opening tag is always its own close tag.
export function stripDeadAnchors(html) {
  const openTagRe = /<a\s[^>]*>/gi;
  let out = '';
  let i = 0;
  let count = 0;
  let match;
  while ((match = openTagRe.exec(html))) {
    const openStart = match.index;
    const openEnd = openTagRe.lastIndex;
    const openTag = match[0];
    const hrefMatch = openTag.match(/\shref="([^"]*)"/i);
    if (!hrefMatch || !isDeadHref(hrefMatch[1])) continue;
    const closeIdx = html.indexOf('</a>', openEnd);
    if (closeIdx === -1) continue;
    const inner = html.slice(openEnd, closeIdx);
    out += html.slice(i, openStart);
    out += `<span class="frozen-disabled-link">${inner}</span>`;
    i = closeIdx + '</a>'.length;
    openTagRe.lastIndex = i;
    count++;
  }
  out += html.slice(i);
  return { html: out, count };
}

export function ensureNoindex(html) {
  if (/<meta\s+name="robots"[^>]*noindex/i.test(html)) return { html, changed: false };
  if (/<meta\s+name="robots"[^>]*>/i.test(html)) {
    return {
      html: html.replace(/<meta\s+name="robots"[^>]*>/i, '<meta name="robots" content="noindex, nofollow">'),
      changed: true,
    };
  }
  if (html.includes('</head>')) {
    return { html: html.replace('</head>', '  <meta name="robots" content="noindex, nofollow">\n</head>'), changed: true };
  }
  return { html, changed: false };
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (extname(name) === '.html') files.push(p);
  }
  return files;
}

// Only run the directory walk when this is the CLI entrypoint, so the
// exported helpers above can be unit-tested (see postprocess-dist.test.mjs)
// without needing a dist/ directory on disk.
if (process.argv[1] && process.argv[1].endsWith('postprocess-dist.mjs')) {
  const distDir = process.argv[2];
  if (!distDir) {
    console.error('Usage: node postprocess-dist.mjs <path-to-dist-dir>');
    process.exit(1);
  }
  const files = walk(distDir);
  let totalAnchors = 0;
  let totalNoindexFixed = 0;
  for (const file of files) {
    let html = readFileSync(file, 'utf8');
    const anchorResult = stripDeadAnchors(html);
    html = anchorResult.html;
    totalAnchors += anchorResult.count;
    const noindexResult = ensureNoindex(html);
    html = noindexResult.html;
    if (noindexResult.changed) totalNoindexFixed++;
    writeFileSync(file, html);
  }
  console.log(
    `[avatok-freeze] postprocessed ${files.length} HTML files: disabled ${totalAnchors} dead links, ` +
      `force-fixed noindex on ${totalNoindexFixed} pages that Base.astro's patch didn't already cover.`,
  );
}
