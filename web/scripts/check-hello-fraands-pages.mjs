// Published content contract. Invoked by check-homepage.mjs after the GitHub CI build.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const footerGroups = ['Company', 'Influencers', 'Trust & Safety', 'Legal & Payments', 'Explore'];
export const contentRoutes = ['/about', '/how-it-works', '/faq', '/contact', '/press', '/hosts/join', '/hosts/requirements', '/hosts/rules', '/hosts/crisis-script', '/hosts/rates', '/hosts/agreement', '/hosts/kyc', '/safety', '/community-guidelines', '/report', '/grievance', '/emergency', '/women-only', '/lgbtq', '/age-policy', '/terms', '/disclaimer', '/privacy', '/wallet-terms', '/refunds', '/cookies', '/data-deletion', '/intermediary-policy'];
// [HF-HOME-POLISH-2] six links per footer column; the dropped pages are linked from their related pages instead.
export const footerRoutes = ['/about', '/how-it-works', '/faq', '/help', '/contact', '/press', '/hosts/join', '/hosts/requirements', '/hosts/rules', '/hosts/crisis-script', '/hosts/rates', '/hosts/agreement', '/safety', '/community-guidelines', '/report', '/grievance', '/emergency', '/women-only', '/terms', '/disclaimer', '/privacy', '/wallet-terms', '/refunds', '/data-deletion', '/marketplace', '/#naye-dost', '/#moods', '/#people', '/lgbtq', '/hosts/join']; // [HF-VERIFIED-ONLY-1] Explore links LGBTQ+ safety (women's safety stays in Trust & Safety);
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
    // [HF-HOW-COMIC-1 2026-10-18] /how-it-works is a standalone comic page (owner redesign), not the legal layout.
    // [HF-JOIN-PAT-1 2026-10-18] /hosts/join is a standalone Pat-Katha scroll page (owner redesign), not the legal layout.
    if (route !== '/faq' && route !== '/how-it-works' && route !== '/hosts/join') {
      assert.match(body, /class="hf-hindi"[^>]*>\s*<em\b/, `${route}: italic Hindi summary`);
      const registrationPolicies = new Set(['/terms', '/privacy', '/disclaimer', '/community-guidelines']);
      const datedContentPages = new Set(['/about', '/contact', '/cookies', '/data-deletion', '/grievance', '/intermediary-policy', '/press', '/report', '/hosts/agreement', '/hosts/kyc']);
      // [HF-LEGAL-GHAT-1 2026-10-18] Owner: no placeholder lines on public pages — every page carries a real date
      // (replaces the old `Last updated: {{DATE}}` placeholder contract) and none says "preview" or "placeholder".
      assert.match(text(body), /Last updated: \d{4}-\d{2}-\d{2}/, `${route}: dated published page`);
      assert(!/\{\{|\bpreview\b|\bplaceholder\b/i.test(text(body)), `${route}: no draft placeholders`);
      void registrationPolicies; void datedContentPages;
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
  // [HF-HOW-COMIC-1] The comic page tells the masked call in a three-panel strip; billing is by the minute.
  assert.equal((pages.get('/how-it-works').match(/<ol class="hw-strip"[\s\S]*?<\/ol>/)?.[0].match(/<li\b/g) || []).length, 3, 'Three masked-call steps');
  assert(!/by the second|Google Play|Razorpay|Cashfree/i.test(text(pages.get('/how-it-works').match(/<main\b[^>]*>[\s\S]*?<\/main>/)?.[0] || '')), 'How it works: per-minute billing, no payment-gateway names');
  // [HF-JOIN-PAT-1] The join page tells one creator's story in four scroll panels; billing is by the minute.
  assert.equal((pages.get('/hosts/join').match(/<ol class="jp-pats"[\s\S]*?<\/ol>/)?.[0].match(/<li class="jp-pat\b/g) || []).length, 4, 'Join: four scroll panels');
  assert(!/by the second|exact seconds|Google Play|Razorpay|Cashfree/i.test(text(pages.get('/hosts/join').match(/<main\b[^>]*>[\s\S]*?<\/main>/)?.[0] || '')), 'Join: per-minute billing, no payment-provider names');
  const hostJoin = text(pages.get('/hosts/join'));
  // [HF-JOIN-PAT-2 2026-10-18] Owner model: free account, free upgrade in the dashboard, own rate (no range), India only. [HF-WIRE-15 2026-10-19] We keep ₹2 a minute plus 40% of the rate above ₹2 (HF-REEL-30).
  for (const copy of [
    'Fans are charged per minute of the phone call.',
    'We keep ₹2 a minute plus 40% of the rate above ₹2. You keep the rest.', // [HF-WIRE-15 2026-10-19] HF-REEL-30
    'The part we keep includes platform fees and GST.',
    'Being online does not guarantee calls.',
    'Before TDS or your own taxes.',
    'Open to influencers in India.',
  ]) assert(hostJoin.includes(copy), 'Current host earnings contract: ' + copy);
  assert(!/video KYC|Aadhaar|DigiLocker|₹5 to ₹1,000/i.test(text(pages.get('/hosts/join').match(/<main\b[^>]*>[\s\S]*?<\/main>/)?.[0] || '')), 'Join: no registration-process details or price range');
  const hostRates = text(pages.get('/hosts/rates'));
  for (const copy of [
    'Earnings are paid by the minute spoken.', // [HF-BILL-MINUTE-1 2026-10-18] owner: billing is by the minute
    'You choose your own whole-rupee fan price per minute.', // [HF-JOIN-PAT-2 2026-10-18] owner: no price range
    'We keep ₹2 a minute plus 40% of the rate above ₹2. You keep the rest.',
    'Example at ₹20 per minute for one minute spoken: the fan pays ₹20, we keep ₹9.20 (₹2 plus 40% of the other ₹18), and you earn ₹10.80.',
  ]) assert(hostRates.includes(copy), 'Current host rates contract: ' + copy);
  // FAQ and wallet terms describe Standard calling; influencer pricing and
  // earnings are covered separately by the host join/rates contracts above.
  const faqText = text(faq);
  for (const copy of [
    'at the per-minute rate set by the influencer, which you see before you call.',
    'A call is made once we have rung both of you and joined the call. You pay per minute spoken.',
    "By the minute, at the influencer's rate. You need at least ₹20 in your wallet to start a call.",
    'We keep ₹2 a minute plus 40% of the rate above ₹2, and you keep the rest.',
    'If a joined call breaks within the first minute, we charge ₹1 and return the rest to your wallet.',
    'All refunds go back to your wallet, never to your card or UPI.',
  ]) assert(faqText.includes(copy), 'FAQ Standard call contract: ' + copy);
  const wallet = text(pages.get('/wallet-terms'));
  for (const copy of [
    'Each influencer sets their own per-minute rate, and you see it before you call.',
    'Minutes you have already talked are never charged again at a new price.',
    'The rate is shown before you start a call.',
    'You pay by the minute while you are connected.',
    'You need at least ₹20 in your wallet to start a call.',
    'A call is made once we have rung both of you and joined the call.',
    "You are billed by the minute for the time you speak, at the influencer's rate.",
    'Ringing, a declined, cancelled or missed call, and a call that fails before we join you all cost ₹0.',
    'If a joined call breaks within the first minute, we charge ₹1 and return the rest to your wallet.',
    'Anyone can withdraw wallet money with the Withdraw button.', // [HF-WITHDRAW-1] Payout renamed Withdraw (owner 2026-10-23)
    'Influencers earn a share of the rate for every minute spoken.',
  ]) assert(wallet.includes(copy), 'Wallet Standard call contract: ' + copy);
  // [HF-BILL-MINUTE-1 2026-10-18] Owner: per-minute billing, and public pages never name the payment provider.
  for (const route of ['/faq', '/wallet-terms', '/refunds', '/terms', '/hosts/rates', '/data-deletion', '/community-guidelines', '/how-it-works']) {
    const body = text(pages.get(route).match(/<main\b[^>]*>[\s\S]*?<\/main>/)?.[0] || '');
    assert(!/by the second|exact seconds|Google Play|Razorpay|Cashfree/i.test(body), route + ': per-minute billing, no payment-provider names');
  }
  const earningsCoins = [...(pages.get('/hosts/join').match(/<ul class="jp-coins"[\s\S]*?<\/ul>/)?.[0] || '').matchAll(/<small>([^<]+)<\/small><b>([^<]+)<\/b>/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(earningsCoins, [['1 hour', '₹648'], ['1,000 minutes', '₹10,800'], ['3,000 minutes', '₹32,400']], 'Illustrative earnings follow ₹10.80 per minute spoken at a ₹20 fan price');
  for (const [route, phones] of [['/emergency', ['14416', '112', '9152987821', '18602662345']], ['/hosts/crisis-script', ['14416', '112']]]) {
    const links = [...pages.get(route).matchAll(/href="tel:([^"]+)"/g)].map(m => m[1].replace(/[^\d]/g, ''));
    for (const phone of phones) assert(links.includes(phone), `${route}: tap-to-call ${phone}`);
  }
  // The older downloadable card predates the reviewed welfare guidance and is
  // intentionally unlinked until its text is updated to match this page.
  assert(!pages.get('/hosts/crisis-script').includes('href="/hosts/crisis-script.pdf"'), 'Unreviewed crisis PDF is not promoted');
  console.log('Hello Fraands content contracts passed: 28 pages, shared chrome, metadata, review notes, earnings and crisis links.');
}
