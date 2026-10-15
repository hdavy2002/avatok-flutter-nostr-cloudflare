// Published content contract. Invoked by check-homepage.mjs after the GitHub CI build.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const footerGroups = ['Company', 'Influencers', 'Trust & Safety', 'Legal & Payments', 'Explore'];
export const contentRoutes = ['/about', '/how-it-works', '/faq', '/contact', '/press', '/hosts/join', '/hosts/requirements', '/hosts/rules', '/hosts/crisis-script', '/hosts/rates', '/hosts/agreement', '/hosts/kyc', '/safety', '/community-guidelines', '/report', '/grievance', '/emergency', '/women-only', '/lgbtq', '/age-policy', '/terms', '/disclaimer', '/privacy', '/wallet-terms', '/refunds', '/cookies', '/data-deletion', '/intermediary-policy'];
export const footerRoutes = [...contentRoutes.slice(0, 3), '/help', ...contentRoutes.slice(3, 14), '/talk-safely', ...contentRoutes.slice(14), '/marketplace', '/#naye-dost', '/#moods', '/#people', '/#women-only', '/#earn'];
const reviewRoutes = new Set(['/hosts/requirements', '/hosts/rules', '/hosts/crisis-script', '/hosts/agreement', '/community-guidelines', '/women-only', '/lgbtq', '/grievance', '/emergency', '/terms', '/disclaimer', '/privacy', '/wallet-terms', '/refunds', '/intermediary-policy']);
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
    // [HELLO-FRAANDS-FAQ-1] /faq is a standalone help page (topic tiles, search,
    // accordions), not the HelloFraandsPage legal layout, so it has no summary/date line.
    if (route !== '/faq') {
      assert.match(body, /class="hf-hindi"[^>]*>\s*<em\b/, `${route}: italic Hindi summary`);
      const registrationPolicies = new Set(['/terms', '/privacy', '/disclaimer', '/community-guidelines']);
      const datedContentPages = new Set(['/about', '/contact', '/cookies', '/data-deletion', '/grievance', '/intermediary-policy', '/press', '/report', '/hosts/agreement', '/hosts/kyc']);
      if (registrationPolicies.has(route) || datedContentPages.has(route)) {
        assert.match(text(body), /Last updated: \d{4}-\d{2}-\d{2}/, `${route}: dated published page`);
        if (registrationPolicies.has(route)) {
          assert(!/\{\{|\bpreview\b|\bplaceholder\b/i.test(text(body)), `${route}: no draft placeholders`);
        }
      } else {
        assert(text(body).includes('Last updated: {{DATE}}'), `${route}: date placeholder`);
      }
    }
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
  const faq = pages.get('/faq').match(/<main\b[^>]*>[\s\S]*?<\/main>/)?.[0] || '';
  assert((faq.match(/<details\b[^>]*class="faq-item"/g) || []).length >= 15, 'FAQ has at least 15 accessible accordions');
  assert((pages.get('/faq').match(/"@type":"FAQPage"/g) || []).length === 1, 'FAQ emits FAQPage structured data once');
  assert.equal((pages.get('/how-it-works').match(/class="phone-frame"/g) || []).length, 3, 'Three masked-call steps');
  const hostJoin = text(pages.get('/hosts/join'));
  for (const copy of [
    'Influencers complete full video KYC and choose a fan price from ₹5 to ₹1,000 per minute',
    'they receive 60% of the connected-call charge minus ₹2.00 per connected minute for the telephone call.',
    'Being online does not guarantee calls.',
    'Amounts below are before TDS or your own taxes.',
  ]) assert(hostJoin.includes(copy), 'Current host earnings contract: ' + copy);
  const hostRates = text(pages.get('/hosts/rates'));
  for (const copy of [
    'Earnings are paid by the second, only for connected time.',
    'You choose a whole-rupee fan price from ₹5 to ₹1,000 per minute.',
    'Your earnings are 60% of the connected-call charge, minus ₹2.00 for each connected minute to cover the telephone call.',
    'Example at ₹20 per minute for a one-minute connected call: the fan pays ₹20, your earning is ₹10, ₹2 covers the call, and the platform share is ₹8.',
  ]) assert(hostRates.includes(copy), 'Current host rates contract: ' + copy);
  // FAQ and wallet terms describe Standard calling; influencer pricing and
  // earnings are covered separately by the host join/rates contracts above.
  const faqText = text(faq);
  for (const copy of [
    'at the per-minute rate set by the influencer, which you see before you call.',
    'Only once both of you are connected. Ringing, an influencer declining, or a call that never connects costs nothing.',
    'By the second of connected time, with no rounding up to a full minute.',
    "You need at least two minutes of balance at the influencer's rate in your wallet to start a call.",
    'Your earnings are 60% of the connected-call charge, minus ₹2.00 for each connected minute to cover the telephone call.',
  ]) assert(faqText.includes(copy), 'FAQ Standard call contract: ' + copy);
  const wallet = text(pages.get('/wallet-terms'));
  for (const copy of [
    'Each influencer sets their own per-minute rate, and you see it before you call.',
    'Minutes you have already talked are never charged again at a new price.',
    'The rate is shown before you start a call.',
    'You pay only for the seconds you are connected.',
    "You need at least two minutes of balance at the influencer's rate in your wallet to start a call.",
    'Billing starts only when influencer and caller are connected, not while a phone rings or the influencer decides.',
    'You are billed for the exact seconds you are connected, with no rounding up to a full minute.',
    'Ringing, a declined or missed call, a failed connection and waiting all cost ₹0.',
    'Influencers earn a share of the rate for every connected minute, paid by the second.',
  ]) assert(wallet.includes(copy), 'Wallet Standard call contract: ' + copy);
  const earningsTable = pages.get('/hosts/join').match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || '';
  const earningsRows = [...earningsTable.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(row => [...row[1].matchAll(/<td>([^<]+)<\/td>/g)].map(cell => cell[1]));
  assert.deepEqual(earningsRows, [
    ['1 hour', '₹10.00', '₹600'],
    ['1,000 minutes', '₹10.00', '₹10,000'],
    ['3,000 minutes', '₹10.00', '₹30,000'],
  ], 'Illustrative earnings follow ₹10.00 per connected minute at a ₹20 fan price');
  for (const [route, phones] of [['/emergency', ['14416', '112', '9152987821', '18602662345']], ['/hosts/crisis-script', ['14416', '112']]]) {
    const links = [...pages.get(route).matchAll(/href="tel:([^"]+)"/g)].map(m => m[1].replace(/[^\d]/g, ''));
    for (const phone of phones) assert(links.includes(phone), `${route}: tap-to-call ${phone}`);
  }
  // The older downloadable card predates the reviewed welfare guidance and is
  // intentionally unlinked until its text is updated to match this page.
  assert(!pages.get('/hosts/crisis-script').includes('href="/hosts/crisis-script.pdf"'), 'Unreviewed crisis PDF is not promoted');
  console.log('Hello Fraands content contracts passed: 28 pages, shared chrome, metadata, review notes, earnings and crisis links.');
}
