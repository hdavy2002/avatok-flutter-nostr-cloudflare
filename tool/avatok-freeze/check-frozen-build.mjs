#!/usr/bin/env node
// [06-FREEZE-AVATOK] Post-build smoke check for the frozen avatok.ai
// snapshot's dist/ output. This is deliberately NOT web/scripts/check-
// homepage.mjs — that script asserts the opposite of what this build wants
// (it fails if the homepage contains "noindex" at all, and requires
// href="/sign-up" and href="/marketplace" to be live links; the frozen build
// forces noindex everywhere and turns both of those into inert spans). See
// tool/avatok-freeze/README.md for why the two checks cannot share a script.
//
// Usage: node check-frozen-build.mjs <path-to-dist-dir>

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const distDir = process.argv[2];
if (!distDir || !existsSync(distDir)) {
  console.error('Usage: node check-frozen-build.mjs <path-to-dist-dir>');
  process.exit(1);
}

let failures = 0;
function check(cond, message) {
  if (!cond) {
    failures++;
    console.error(`[FAIL] ${message}`);
  } else {
    console.log(`[ok]   ${message}`);
  }
}

// 1. The dead routes prepare-source.mjs deletes from src/pages must not
//    exist anywhere in the built output.
const DEAD_DIRS = [
  '[username]', 'admin', 'agent', 'api', 'book', 'c', 'consult', 'dashboard',
  'e', 'embed', 'explore', 'forgot-password', 'india', 'j', 'l', 'live',
  'marketplace', 'pay', 'session', 'sign-in', 'sign-out', 'sign-up',
  'sso-callback', 'talk', 'test', 'vision', 'watch',
];
for (const dir of DEAD_DIRS) {
  check(!existsSync(join(distDir, dir)), `dist/${dir} does not exist (SSR/auth/checkout route stayed dead)`);
}

// 2. robots.txt disallows everything.
const robotsPath = join(distDir, 'robots.txt');
check(existsSync(robotsPath), 'dist/robots.txt exists');
if (existsSync(robotsPath)) {
  const robots = readFileSync(robotsPath, 'utf8');
  check(/Disallow:\s*\/\s*$/m.test(robots), 'robots.txt disallows all crawling');
}

// 3. No AI-crawler discovery feeds survive (they'd point at dead routes and
//    contradict the disallow-all/noindex policy).
check(!existsSync(join(distDir, 'llms.txt')), 'dist/llms.txt does not exist (AI-crawler feed removed)');
check(!existsSync(join(distDir, 'llms-creator-ideas.txt')), 'dist/llms-creator-ideas.txt does not exist');
check(!existsSync(join(distDir, 'sitemap.xml')), 'dist/sitemap.xml does not exist (pointed at deleted dynamic feeds)');

// 4. Homepage: noindex present, dead CTAs neutralized, no unconverted links
//    to a dead route survive.
const homepagePath = join(distDir, 'index.html');
check(existsSync(homepagePath), 'dist/index.html exists');
if (existsSync(homepagePath)) {
  const home = readFileSync(homepagePath, 'utf8');
  check(/<meta\s+name="robots"[^>]*noindex/i.test(home), 'homepage has a noindex robots meta tag');
  check(!/href="\/sign-up(?:["/?#]|$)/.test(home), 'homepage has no live /sign-up link');
  check(!/href="\/sign-in(?:["/?#]|$)/.test(home), 'homepage has no live /sign-in link');
  check(!/href="\/marketplace(?:["/?#]|$)/.test(home), 'homepage has no live /marketplace link');
  check(/frozen-disabled-link/.test(home), 'homepage has at least one neutralized dead CTA span');
  check(!/application\/ld\+json/.test(home) || !/"@type":\s*"Organization"/.test(home),
    'homepage does not emit the live Organization JSON-LD (Base.astro skips it when noindex is true)');
}

// 5. Every HTML file in the build is noindex — belt-and-suspenders check on
//    top of postprocess-dist.mjs's own per-file pass.
function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (extname(name) === '.html') files.push(p);
  }
  return files;
}
const htmlFiles = walk(distDir);
let missingNoindex = 0;
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  if (!/<meta\s+name="robots"[^>]*noindex/i.test(html)) {
    missingNoindex++;
    console.error(`[FAIL] missing noindex: ${file}`);
  }
}
check(missingNoindex === 0, `all ${htmlFiles.length} HTML pages carry a noindex meta tag`);

console.log(`\n[avatok-freeze] check-frozen-build: ${htmlFiles.length} HTML files scanned, ${failures} failure(s).`);
if (failures > 0) process.exit(1);
