import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { BRAND } from '../src/lib/brand.ts';
import ts from 'typescript';

// Node's type stripping does not resolve the extensionless imports used by Astro.
// Load the real policy with its brand dependency resolved explicitly for Node.
const source = readFileSync(new URL('../src/lib/securityHeaders.ts', import.meta.url), 'utf8')
  .replace("from './brand'", `from '${new URL('../src/lib/brand.ts', import.meta.url).href}'`);
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
} });
const { SECURITY_HEADERS, REPORT_ONLY_CSP, withSecurityHeaders } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
);

const production = new URL(BRAND.webOrigin);

test('HEADERS-01: policy preserves SSR, redirect, gone and error response semantics', async () => {
  for (const status of [200, 301, 404, 410, 500]) {
    const source = new Response('original body', { status, headers: {
      'Cache-Control': status === 500 ? 'no-store' : 'public, max-age=60',
      'Location': '/blog/', 'Set-Cookie': 'session=fixture; Secure; HttpOnly',
      'X-Edge-Cache': 'MISS',
    } });
    const out = withSecurityHeaders(source, production);
    assert.equal(out.status, status);
    assert.equal(await out.text(), 'original body');
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) assert.equal(out.headers.get(key), value);
    for (const key of ['cache-control', 'location', 'set-cookie', 'x-edge-cache']) {
      assert.equal(out.headers.get(key), source.headers.get(key));
    }
    assert.equal(source.headers.has('Content-Security-Policy'), false);
  }
});

test('HEADERS-01: stale cached policy is replaced on HIT without changing cache metadata', () => {
  const out = withSecurityHeaders(new Response('cached', { headers: {
    'Content-Security-Policy': "default-src *", 'X-Edge-Cache': 'HIT',
    'Cache-Control': 'public, max-age=60', 'ETag': '"fixture"',
  } }), production);
  assert.equal(out.headers.get('Content-Security-Policy'), SECURITY_HEADERS['Content-Security-Policy']);
  assert.equal(out.headers.get('X-Edge-Cache'), 'HIT');
  assert.equal(out.headers.get('ETag'), '"fixture"');
});

test('HSTS is limited to canonical HTTPS, with no subdomain/preload commitment', () => {
  assert.equal(withSecurityHeaders(new Response(), production).headers.get('Strict-Transport-Security'), 'max-age=86400');
  for (const url of [production.href.replace('https:', 'http:'), 'https://preview.pages.dev/', 'http://localhost:4321/', `https://other.${BRAND.domain}/`]) {
    assert.equal(withSecurityHeaders(new Response(), new URL(url)).headers.has('Strict-Transport-Security'), false);
  }
});

test('HEADERS-01: Pages static header mirror matches SSR policy after brand substitution', () => {
  const text = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
    .replaceAll('%BRAND_DOMAIN%', BRAND.domain).replaceAll('%BRAND_ORIGIN%', BRAND.webOrigin);
  const block = text.split('\n/*\n')[1].split('\n\n')[0];
  const headers = new Headers(block.trim().split('\n').map((line) => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()] as [string, string];
  }));
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) assert.equal(headers.get(key), value, key);
  assert.equal(headers.has('Strict-Transport-Security'), false);
  assert.ok(text.includes(`${BRAND.webOrigin}/*\n  Strict-Transport-Security: max-age=86400`));
});

test('HEADERS-02/04: baseline blocks external ancestors; script tightening stays report-only', () => {
  assert.ok(SECURITY_HEADERS['Content-Security-Policy'].includes("frame-ancestors 'self'"));
  assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'SAMEORIGIN');
  assert.ok(!SECURITY_HEADERS['Content-Security-Policy'].includes('script-src'));
  const script = REPORT_ONLY_CSP.split('; ').find((directive) => directive.startsWith('script-src '))!;
  assert.ok(script);
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(script));
});
