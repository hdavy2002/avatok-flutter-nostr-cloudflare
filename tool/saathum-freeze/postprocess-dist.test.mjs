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
import { applyNoindex, processHtml, rewriteLinks, stripThirdParty, urlPathForFile } from './postprocess-dist.mjs';
import { REDIRECT_PREFIXES, REDIRECT_TARGET, functionalRedirectRules, loadBrand } from './freeze-config.mjs';
import { buildRedirects } from './prepare-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// --- urlPathForFile / canonicalUrl ---------------------------------------------
assert.equal(urlPathForFile('/d', '/d/index.html'), '/');
assert.equal(urlPathForFile('/d', '/d/about/index.html'), '/about');
assert.equal(urlPathForFile('/d', '/d/help/a/b/index.html'), '/help/a/b');
assert.equal(urlPathForFile('/d', '/d/404.html'), '/');
assert.equal(urlPathForFile('/d', '/d/offline.html'), '/offline');
console.log('urlPathForFile: OK');

// --- applyNoindex ---------------------------------------------------------------------
{
  const html =
    '<html><head><link rel="canonical" href="https://old.test/x">' +
    '<meta name="robots" content="index, follow, max-snippet:-1">' +
    '<link rel="sitemap" type="application/xml" href="/sitemap.xml">' +
    '<script type="application/ld+json">{"@type":"Organization"}</script>' +
    '<title>t</title></head><body></body></html>';
  const out = applyNoindex(html);
  assert.equal((out.match(/<meta name="robots"/g) ?? []).length, 1);
  assert.match(out, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(out, /index, follow/);
  assert.doesNotMatch(out, /canonical|sitemap|ld\+json|frozen-banner/);
  assert.match(applyNoindex('<head><title>x</title></head>'), /noindex/);
}
console.log('applyNoindex: OK');

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
  const { html: out, disabled } = rewriteLinks(html, hasPath);
  assert.equal(disabled, 4);
  assert.match(out, /<a href="\/about">About<\/a>/, 'kept page untouched');
  assert.match(out, /<span class="frozen-disabled-link">Explore<\/span>/);
  assert.match(out, /<span class="frozen-disabled-link">Log in<\/span>/);
  assert.match(out, /<span class="frozen-disabled-link">Wallet<\/span>/);
  assert.match(out, /<span class="frozen-disabled-link">Careers<\/span>/);
  assert.doesNotMatch(out, /href="[^"]*(marketplace|sign-in|dashboard|careers)/);
  assert.match(out, /href="https:\/\/example\.com\/x"/);
  assert.match(out, /href="\/\/cdn\.example\/x"/);
  assert.match(out, /href="\/cdn-cgi\/image\/w=1\/x\.png"/);
  const p = processHtml('<html><head></head><body><a href="/shop">Shop</a></body></html>', { hasPath });
  assert.doesNotMatch(p.html, /<a |canonical|frozen-banner/);
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
    '/rituals/lalita-havan/* /rituals/ 301\n/j /elsewhere 301\n/off /x https://elsewhere.test/y 301\n/off2 https://elsewhere.test/y 301\n';
  const { text, staticCount, dynamicCount } = buildRedirects(existing);
  assert.doesNotMatch(text, /https?:|elsewhere|aumfe/i, 'nothing points off-site');
  const rules = text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(' '));
  const find = (src) => rules.find((r) => r[0] === src);
  for (const p of REDIRECT_PREFIXES) {
    assert.deepEqual(find(`/${p}`), [`/${p}`, '/', '302']);
    assert.deepEqual(find(`/${p}/*`), [`/${p}/*`, '/', '302']);
  }
  for (const must of ['j', 'l', 'book', 'checkout', 'dashboard', 'sign-in', 'sign-up', 'sso-callback', 'watch', 'shop', 'explore', 'marketplace', 'admin', 'live', 'session', 'c', 'saathum', 'e']) {
    assert.ok(REDIRECT_PREFIXES.includes(must), `${must} is redirected`);
  }
  assert.deepEqual(find('/videos'), ['/videos', '/', '301'], 'retired URL to a dead route lands on /');
  assert.deepEqual(find('/coming-soon'), ['/coming-soon', '/', '301'], 'local target kept');
  assert.deepEqual(find('/humphrey/*'), ['/humphrey/*', '/', '301']);
  assert.deepEqual(find('/j'), ['/j', '/', '302'], 'functional rule wins over an existing rule for the same source');
  assert.equal(find('/off2'), undefined, 'off-site rule dropped');
  const firstDynamic = rules.findIndex((r) => r[0].includes('*'));
  assert.ok(rules.slice(firstDynamic).every((r) => r[0].includes('*')), 'static rules precede dynamic rules');
  assert.ok(staticCount <= 2000 && dynamicCount <= 100);
  assert.equal(functionalRedirectRules().dynamics.length, REDIRECT_PREFIXES.length);
  assert.equal(REDIRECT_TARGET, '/');
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
    const { text } = buildRedirects('');
    writeFileSync(join(dist, '_redirects'), text);
    const env = { ...process.env };
    const run = (script) => spawnSync('node', [join(here, script), dist], { env, encoding: 'utf8' });

    const pp = run('postprocess-dist.mjs');
    assert.equal(pp.status, 0, pp.stderr);
    const ok = run('check-frozen-build.mjs');
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.doesNotMatch(readFileSync(join(dist, 'about', 'index.html'), 'utf8'), /canonical|frozen-banner/);

    // forbidden reference -> check fails
    writeFileSync(join(dist, '_astro_x.js'), `fetch("https://${loadBrand().hosts.api}/api/x")`);
    assert.equal(run('check-frozen-build.mjs').status, 1, 'API host in a built file must fail the check');
    rmSync(join(dist, '_astro_x.js'));
    // a canonical, a banner, or any trace of the new site -> check fails
    const p = join(dist, 'terms', 'index.html');
    const good = readFileSync(p, 'utf8');
    for (const [label, bad] of [
      ['canonical', good.replace('</head>', '<link rel="canonical" href="/terms"></head>')],
      ['banner', good.replace('<body>', '<body><div id="frozen-banner">x</div>')],
      ['aumfe in html', good.replace('<main>', '<main>see AumFe.com')],
      ['Aum Fe in html', good.replace('<main>', '<main>Aum Fe')],
    ]) {
      writeFileSync(p, bad);
      assert.equal(run('check-frozen-build.mjs').status, 1, `${label} must fail the check`);
    }
    writeFileSync(p, good);
    for (const f of ['x.js', 'x.json', 'x.txt', 'x.xml']) {
      writeFileSync(join(dist, f), 'https://aumfe.com/');
      assert.equal(run('check-frozen-build.mjs').status, 1, `aumfe in ${f} must fail the check`);
      rmSync(join(dist, f));
    }
    const redirects = readFileSync(join(dist, '_redirects'), 'utf8');
    writeFileSync(join(dist, '_headers'), '/*\n  Link: <https://AUMFE.com/>; rel=x\n');
    assert.equal(run('check-frozen-build.mjs').status, 1, 'aumfe in _headers must fail the check');
    rmSync(join(dist, '_headers'));
    writeFileSync(join(dist, '_redirects'), redirects + '/zz https://other.test/ 302\n');
    assert.equal(run('check-frozen-build.mjs').status, 1, 'an off-site redirect must fail the check');
    writeFileSync(join(dist, '_redirects'), redirects);
    assert.equal(run('check-frozen-build.mjs').status, 0, 'restored dist passes again');
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
