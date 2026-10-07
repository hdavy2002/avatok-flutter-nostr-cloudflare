// Published content contract. Invoked by check-homepage.mjs after the GitHub CI build.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
export const footerGroups = ['Company', 'Hosts', 'Trust & Safety', 'Legal & Payments', 'Explore'];
export const contentRoutes = ['/about', '/how-it-works', '/faq', '/contact', '/press', '/hosts/join', '/hosts/requirements', '/hosts/rules', '/hosts/crisis-script', '/hosts/rates', '/hosts/agreement', '/hosts/kyc', '/safety', '/community-guidelines', '/recording-policy', '/report', '/grievance', '/emergency', '/women-only', '/age-policy', '/terms', '/disclaimer', '/privacy', '/wallet-terms', '/refunds', '/cookies', '/data-deletion', '/intermediary-policy'];
export const footerRoutes = [...contentRoutes.slice(0, 14), '/talk-safely', ...contentRoutes.slice(14), '/#moods', '/#people', '/#women-only', '/?mood=kundli#people', '/#earn'];
const reviewRoutes = new Set(['/hosts/requirements', '/hosts/rules', '/hosts/crisis-script', '/hosts/agreement', '/community-guidelines', '/recording-policy', '/women-only', '/grievance', '/emergency', '/terms', '/disclaimer', '/privacy', '/wallet-terms', '/refunds', '/intermediary-policy']);
const text = html => html.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ').replaceAll('&amp;', '&').replace(/\s+/g, ' ').trim();
export function checkHelloFraandsPages(root, identity) {
  assert.equal(identity.name, 'Hello Fraands', 'Requested public identity');
  assert.equal(identity.domain, 'hellofraands.com', 'Requested canonical domain');
  assert.equal(contentRoutes.length, 28, 'All 28 requested content pages');
  const pages = new Map();
  for (const route of contentRoutes) {
    const html = readFileSync(resolve(root, route.slice(1), 'index.html'), 'utf8');
    pages.set(route, html);
    const body = html.match(/<main\b[^>]*>[\s\S]*?<\/main>/)?.[0] || '';
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1, `${route}: one H1`);
    assert.match(body, /class="hf-hindi"[^>]*>\s*<em\b/, `${route}: italic Hindi summary`);
    assert(text(body).includes('Last updated: {{DATE}}'), `${route}: date placeholder`);
    assert.match(body, /<h2\b/, `${route}: real structured content`);
    assert.equal((html.match(/<header\b[^>]*data-callvaal-chrome/g) || []).length, 1, `${route}: shared header`);
    assert.equal((html.match(/<footer\b[^>]*data-callvaal-chrome/g) || []).length, 1, `${route}: shared footer`);
    assert(!text(html).includes('CallVaal'), `${route}: retired visible brand absent`);
    const canonical = html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/)?.[1];
    assert(canonical, `${route}: canonical exists`);
    const url = new URL(canonical);
    assert.equal(url.origin, `https://${identity.domain}`, `${route}: canonical host`);
    assert.equal(url.pathname.replace(/\/$/, ''), route, `${route}: canonical path`);
    assert(html.includes(`property="og:url" content="${canonical}"`), `${route}: OG URL matches canonical`);
    if (reviewRoutes.has(route)) {
      const note = html.match(/<aside\b[^>]*class="hf-review-note"[^>]*>([\s\S]*?)<\/aside>/)?.[1] || '';
      assert(text(note).includes('This page is under legal review.'), `${route}: review note`);
      const related = [...note.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
      assert(related.some(href => reviewRoutes.has(href) && href !== route), `${route}: related review page`);
    }
  }
  const faq = pages.get('/faq').match(/<div\b[^>]*class="hf-prose"[^>]*>([\s\S]*?)<\/article>/)?.[1] || '';
  assert((faq.match(/<details\b/g) || []).length >= 15, 'FAQ has at least 15 accessible accordions');
  assert.equal((pages.get('/how-it-works').match(/class="phone-frame"/g) || []).length, 3, 'Three masked-call steps');
  for (const amount of ['₹32,400', '₹41,400', '₹50,400']) assert(text(pages.get('/hosts/join')).includes(amount), 'Net illustrative earnings: ' + amount);
  for (const amount of ['₹9.20', '₹10.80']) assert(text(pages.get('/hosts/rates')).includes(amount), '₹20 split: ' + amount);
  for (const [route, phones] of [['/emergency', ['14416', '112', '9152987821', '18602662345']], ['/hosts/crisis-script', ['14416', '112']]]) {
    const links = [...pages.get(route).matchAll(/href="tel:([^"]+)"/g)].map(m => m[1].replace(/[^\d]/g, ''));
    for (const phone of phones) assert(links.includes(phone), `${route}: tap-to-call ${phone}`);
  }
  const pdf = resolve(root, 'hosts/crisis-script.pdf');
  assert(existsSync(pdf), 'Crisis-script PDF ships');
  assert.equal(readFileSync(pdf).subarray(0, 5).toString(), '%PDF-', 'Download is a PDF');
  assert(pages.get('/hosts/crisis-script').includes('href="/hosts/crisis-script.pdf"'), 'Script links its PDF');
  console.log('Hello Fraands content contracts passed: 28 pages, shared chrome, metadata, review notes, earnings, crisis links and PDF.');
}
