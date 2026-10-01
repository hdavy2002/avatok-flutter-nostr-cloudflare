// [SAATHUM-FREEZE-1] Zero-dependency tests for postprocess-dist.mjs and
// check-frozen-build.mjs. Plain `node`, no npm install.
//
// Usage: node tool/saathum-freeze/postprocess-dist.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BANNER_ID,
  applyNoindexAndCanonical,
  bannerHtml,
  canonicalUrl,
  injectBanner,
  processHtml,
  rewriteLinks,
  stripThirdParty,
  urlPathForFile,
} from './postprocess-dist.mjs';
import { REDIRECT_PREFIXES, functionalRedirectRules, resolveNewOrigin, loadOldBrandName } from './freeze-config.mjs';
import { buildRedirects } from './prepare-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://new.example';

// --- urlPathForFile / canonicalUrl ---------------------------------------------
assert.equal(urlPathForFile('/d', '/d/index.html'), '/');
assert.equal(urlPathForFile('/d', '/d/about/index.html'), '/about');
assert.equal(urlPathForFile('/d', '/d/help/a/b/index.html'), '/help/a/b');
assert.equal(urlPathForFile('/d', '/d/404.html'), '/');
assert.equal(urlPathForFile('/d', '/d/offline.html'), '/offline');
assert.equal(canonicalUrl(ORIGIN, '/'), `${ORIGIN}/`);
assert.equal(canonicalUrl(ORIGIN, '/about'), `${ORIGIN}/about`);
console.log('urlPathForFile / canonicalUrl: OK');

// --- resolveNewOrigin ----------------------------------------------------------------
assert.equal(resolveNewOrigin(['node', 'x'], {}).startsWith('https://'), true);
assert.equal(resolveNewOrigin(['node', 'x', '--new-origin=https://a.test/'], {}), 'https://a.test');
assert.equal(resolveNewOrigin(['node', 'x'], { NEW_ORIGIN: 'https://b.test' }), 'https://b.test');
assert.throws(() => resolveNewOrigin(['node', 'x'], { NEW_ORIGIN: 'http://insecure.test' }));
assert.throws(() => resolveNewOrigin(['node', 'x'], { NEW_ORIGIN: 'https://a.test/path' }));
console.log('resolveNewOrigin: OK');

// --- applyNoindexAndCanonical ------------------------------------------------------------
{
  const html =
    '<html><head><link rel="canonical" href="https://old.test/x">' +
    '<meta name="robots" content="index, follow, max-snippet:-1">' +
    '<link rel="sitemap" type="application/xml" href="/sitemap.xml">' +
    '<meta property="og:url" content="https://old.test/x">' +
    '<script type="application/ld+json">{"@type":"Organization"}</script>' +
    '<title>t</title></head><body></body></html>';
  const out = applyNoindexAndCanonical(html, `${ORIGIN}/x`);
  assert.equal((out.match(/<meta name="robots"/g) ?? []).length, 1);
  assert.match(out, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(out, /index, follow/);
  assert.equal((out.match(/rel="canonical"/g) ?? []).length, 1);
  assert.match(out, /<link rel="canonical" href="https:\/\/new\.example\/x">/);
  assert.match(out, /og:url" content="https:\/\/new\.example\/x"/);
  assert.doesNotMatch(out, /sitemap|ld\+json/);
  // a page with neither tag still gets both
  const bare = applyNoindexAndCanonical('<head><title>x</title></head>', `${ORIGIN}/`);
  assert.match(bare, /noindex/);
  assert.match(bare, /rel="canonical" href="https:\/\/new\.example\/"/);
}
console.log('applyNoindexAndCanonical: OK');

// --- banner -------------------------------------------------------------------------------------
{
  const banner = bannerHtml({ oldBrand: 'Old <Brand>', newBrand: 'new.example', href: `${ORIGIN}/about` });
  assert.match(banner, /Old &lt;Brand&gt; is now at <a href="https:\/\/new\.example\/about"[^>]*>new\.example<\/a>/);
  const size = Number(/font:[^;"]*?(\d+)px/.exec(banner)[1]);
  assert.ok(size >= 14, 'banner font is at least 14px');
  const html = '<html><head></head><body class="x"><main>hi</main></body></html>';
  const once = injectBanner(html, banner);
  assert.match(once, /<body class="x">\s*<div id="frozen-banner"/);
  assert.equal(injectBanner(once, banner), once, 'injecting twice changes nothing');
  assert.equal(BANNER_ID, 'frozen-banner');
}
console.log('banner: OK');

// --- rewriteLinks -------------------------------------------------------------------------------------
{
  const here_ = new Set(['/about', '/help/x', '/']);
  const hasPath = (p) => here_.has(p.split('#')[0].split('?')[0]);
  const html =
    '<a href="/about">About</a>' +
    '<a class="a" href="/marketplace?group=x&amp;y=1">Explore</a>' +
    '<a href="/sign-in">Log in</a>' +
    '<a href="/dashboard/wallet">Wallet</a>' +
    '<a href="/careers">Careers</a>' +
    '<a href="https://example.com/x">Ext</a>' +
    '<a href="//cdn.example/x">Proto-relative</a>' +
    '<a href="#top">Top</a>' +
    '<a href="/cdn-cgi/image/w=1/x.png">Img</a>';
  const { html: out, toNew, disabled } = rewriteLinks(html, hasPath, ORIGIN);
  assert.equal(toNew, 3);
  assert.equal(disabled, 1);
  assert.match(out, /<a href="\/about">About<\/a>/, 'kept page untouched');
  assert.match(out, /href="https:\/\/new\.example\/marketplace\?group=x&amp;y=1"/, 'query preserved');
  assert.match(out, /href="https:\/\/new\.example\/sign-in"/);
  assert.match(out, /href="https:\/\/new\.example\/dashboard\/wallet"/);
  assert.match(out, /<span class="frozen-disabled-link">Careers<\/span>/, 'deleted, not redirected -> inert');
  assert.match(out, /href="https:\/\/example\.com\/x"/);
  assert.match(out, /href="\/\/cdn\.example\/x"/);
  assert.match(out, /href="\/cdn-cgi\/image\/w=1\/x\.png"/);
}
console.log('rewriteLinks: OK');

// --- stripThirdParty ------------------------------------------------------------------------------------
{
  const html =
    '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' +
    '<script src="https://clerk.example.com/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>' +
    '<link rel="preconnect" href="https://api.example.com">' +
    '<script src="/_astro/keep.js"></script>';
  const out = stripThirdParty(html).html;
  assert.equal(out, '<script src="/_astro/keep.js"></script>');
}
console.log('stripThirdParty: OK');

// --- buildRedirects ----------------------------------------------------------------------------------------
{
  const existing =
    '# comment\n/videos /marketplace 301\n/coming-soon / 301\n/humphrey/* /saathum/:splat 301\n' +
    '/rituals/lalita-havan/* /rituals/ 301\n/j /elsewhere 301\n';
  const { text, staticCount, dynamicCount } = buildRedirects(existing, ORIGIN);
  const rules = text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(' '));
  const find = (src) => rules.find((r) => r[0] === src);
  for (const p of REDIRECT_PREFIXES) {
    assert.deepEqual(find(`/${p}`), [`/${p}`, `${ORIGIN}/${p}`, '301']);
    assert.deepEqual(find(`/${p}/*`), [`/${p}/*`, `${ORIGIN}/${p}/:splat`, '301']);
  }
  for (const must of ['j', 'l', 'book', 'checkout', 'dashboard', 'sign-in', 'sign-up', 'sso-callback', 'watch', 'shop', 'explore', 'marketplace', 'admin', 'live', 'session', 'c', 'saathum', 'e']) {
    assert.ok(REDIRECT_PREFIXES.includes(must), `${must} is redirected`);
  }
  assert.deepEqual(find('/videos'), ['/videos', `${ORIGIN}/marketplace`, '301'], 'retired URL retargeted to the live site');
  assert.deepEqual(find('/coming-soon'), ['/coming-soon', '/', '301'], 'local target kept');
  assert.deepEqual(find('/humphrey/*'), ['/humphrey/*', `${ORIGIN}/saathum/:splat`, '301']);
  assert.deepEqual(find('/j'), ['/j', `${ORIGIN}/j`, '301'], 'functional rule wins over an existing rule for the same source');
  const firstDynamic = rules.findIndex((r) => r[0].includes('*'));
  assert.ok(rules.slice(firstDynamic).every((r) => r[0].includes('*')), 'static rules precede dynamic rules');
  assert.ok(staticCount <= 2000 && dynamicCount <= 100);
  assert.equal(functionalRedirectRules(ORIGIN).dynamics.length, REDIRECT_PREFIXES.length);
}
console.log('buildRedirects: OK');

// --- end to end: fake dist -> postprocess -> check passes; then broken dist fails ------------------------
{
  const dist = mkdtempSync(join(tmpdir(), 'saathum-freeze-test-'));
  try {
    const page = (title, extra = '') =>
      `<!doctype html><html><head><meta name="robots" content="index, follow"><link rel="canonical" href="https://old.test/"><title>${title}</title></head>` +
      `<body><main>${title}${extra}</main><a href="/marketplace">Explore</a><a href="/about">About</a></body></html>`;
    const pages = {
      'index.html': page('Home'), '404.html': page('Nope'), 'about/index.html': page('About'),
      'how-it-works/index.html': page('How'), 'temples/index.html': page('Temples'), 'rituals/index.html': page('Rituals'),
      'rituals/ganesh/index.html': page('Ganesh'), 'help/index.html': page('Help'), 'help/a/b/index.html': page('Article'),
      'contact/index.html': page('Contact'), 'terms/index.html': page('Terms'), 'privacy/index.html': page('Privacy'),
      'refunds/index.html': page('Refunds'), 'cookies/index.html': page('Cookies'), 'disclaimer/index.html': page('Disclaimer'),
      'grievance/index.html': page('Grievance'),
    };
    for (const [f, html] of Object.entries(pages)) {
      mkdirSync(dirname(join(dist, f)), { recursive: true });
      writeFileSync(join(dist, f), html);
    }
    writeFileSync(join(dist, 'help', 'search.json'), '[]');
    writeFileSync(join(dist, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
    const { text } = buildRedirects('', 'https://example.org');
    writeFileSync(join(dist, '_redirects'), text);
    const env = { ...process.env, NEW_ORIGIN: 'https://example.org', NEW_BRAND_NAME: 'example.org' };
    const run = (script) => spawnSync('node', [join(here, script), dist], { env, encoding: 'utf8' });

    const pp = run('postprocess-dist.mjs');
    assert.equal(pp.status, 0, pp.stderr);
    const ok = run('check-frozen-build.mjs');
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(readFileSync(join(dist, 'about', 'index.html'), 'utf8'), new RegExp(`${loadOldBrandName()} is now at <a href="https://example.org/about"`));

    // forbidden reference -> check fails
    writeFileSync(join(dist, '_astro_x.js'), 'fetch("https://api.saathum.com/api/x")');
    assert.equal(run('check-frozen-build.mjs').status, 1, 'API host in a built file must fail the check');
    rmSync(join(dist, '_astro_x.js'));
    // a page without the banner -> check fails
    const p = join(dist, 'terms', 'index.html');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/<div id="frozen-banner"[\s\S]*?<\/div>/, ''));
    assert.equal(run('check-frozen-build.mjs').status, 1, 'missing banner must fail the check');
    // a deleted route that came back -> check fails
    mkdirSync(join(dist, 'dashboard'), { recursive: true });
    writeFileSync(join(dist, 'dashboard', 'index.html'), pages['index.html']);
    assert.equal(run('check-frozen-build.mjs').status, 1, 'a /dashboard page must fail the check');
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}
console.log('postprocess + check-frozen-build (end to end): OK');

console.log('\nAll saathum-freeze unit tests passed.');
