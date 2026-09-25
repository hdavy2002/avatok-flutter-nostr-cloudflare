// [SHV2-S10] Production-build smoke check for /organisers (Specs/
// saathum-spec-v2-and-agent-plan.md Part A5/A6; ids binding via
// Specs/saathum-home-v2/contracts.md §5). Invoked from check-homepage.mjs so
// it rides that existing CI step without a new workflow trigger — see the
// note there.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeBuiltImages, validateBuiltImageSources } from './built-image-source.mjs';

function meta(page, key) {
  const tags = page.match(/<meta\b[^>]*>/g) || [];
  const tag = tags.find(tag => tag.includes('property="' + key + '"') || tag.includes('name="' + key + '"'));
  return tag?.match(/content="([^"]*)"/)?.[1];
}

const root = resolve('dist');
const builtPath = resolve(root, 'organisers/index.html');
assert(existsSync(builtPath), '/organisers must exist in the production build (AC-02)');
validateBuiltImageSources(root);
const html = normalizeBuiltImages(readFileSync(builtPath, 'utf8'), { root });
const bodyHtml = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? html;

// A5 hero and metadata.
assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'One main heading on /organisers');
assert.match(html, /<title[^>]*>Become a spiritual event organiser \| Saathum/, 'A5 page title');
assert.match(html, /Bring your local spiritual community to the world\./, 'A5 hero H1');
assert.match(html, /Partner with a guru, priest, temple or yoga teacher\. Arrange a live experience, share the booking link and help people take part from home\./, 'A5 hero support line');
assert.match(html, /You bring the organisation\. Your spiritual host brings the experience\./, 'A5 no-immediate-income line');
assert.equal(meta(html, 'og:title'), 'Become a spiritual event organiser | Saathum', 'A5 og:title');
assert.match(html, /Start organising/, 'A5 primary CTA label');

// contracts.md §5 — organiser section ids.
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
for (const id of ['how-to-organise', 'earnings', 'guides', 'faq']) {
  assert(ids.has(id), '/organisers section exists: #' + id);
}
for (const match of html.matchAll(/\bhref="([^"]+)"/g)) {
  const href = match[1].replaceAll('&amp;', '&');
  if (href.startsWith('#') || href.startsWith('/organisers#')) {
    assert(ids.has(href.split('#')[1]), 'Missing /organisers anchor: ' + href);
  }
}

// O9 FAQ — exact questions from A5.
for (const q of ['Do I need followers?', 'Can I organise for someone else?', 'What equipment do I need?', 'Who sets the ticket price?', 'How does the platform fee work?', 'How do attendees join?', 'When can I withdraw?']) {
  assert(html.includes(q), 'FAQ question present: ' + q);
}
assert.match(html, /href="\/payouts"/, 'FAQ withdrawal answer links to /payouts (O9)');
assert.doesNotMatch(html, /withdraw(?:al)?s? (?:are|is) available|instant(?:ly)? withdraw|withdraw (?:to|directly to) your bank/i, 'No bank-payout promise while /payouts says withdrawals are unavailable (O9, AC-11)');
assert.doesNotMatch(html, /\bevery phone\b[\s\S]{0,60}\b2K\b|\b2K\b[\s\S]{0,60}\bevery phone\b/i, 'No universal-2K broadcast claim (O9, AC-11)');

// AC-16 — the canonical fee sentence, verbatim (contracts.md §4).
assert.match(html, /Saathum adds a time fee of ₹50 per participant for every 30 minutes booked \(₹100 per hour\) and keeps 20% of your price\. The 20% does not change with event length\./, 'AC-16 canonical fee sentence, verbatim');

// A6.2/A6.3 — the planner's default scenario (A=₹400, N=50, H=1h) reaches
// the built page. This is a smoke check that the numbers shipped, not a
// re-derivation of the math (S7 owns and tests organiserEarnings.ts).
assert.match(html, /Illustrative earnings plan/, 'A6.2 planner badge');
for (const figure of ['25,000', '16,000', '5,000', '4,000']) {
  assert(html.includes(figure), 'Earnings planner default scenario figure present: ' + figure);
}

// A6.4 — illustrative story, explicitly not a real customer result.
assert.match(html, /Illustrative scenario — not an actual customer result\./, 'A6.4 story disclaimer label');
assert.match(html, /What could a 50-person satsang look like\?/, 'A6.4 story headline');

// D2/AC-17 — no 1:1 consultation or astrology content anywhere on this page.
assert.doesNotMatch(bodyHtml, /\b1:1 video calls?\b|\bastrology\b|\btarot\b|\bpalmistry\b|\bkundli\b/i, 'No 1:1 consultation or astrology content in organiser body (D2, AC-17)');

console.log('/organisers checks passed: sections, metadata, FAQ, canonical fee sentence, planner figures, illustrative story, D2 content ban.');

// The organiser remake shares the approved homepage art and full footer.
assert.match(html, /data-organisers-design="saathum-organisers-v1"/);
assert.match(html, /data-folk-artwork="satsang"/);
assert.match(html, /saathum-bright\/satsang\.png/);
assert.match(html, /Made in India with Love ❤️ and cutting chai\./);
const footer = html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0] ?? '';
// [SAATHUM-ARCHIVE-1 2026-09-25] /organisers is archived (noindex, off the menus) but still renders; its
// footer is the shared Puja & Havan footer.
for (const href of ['/marketplace','/cookies','/refunds','/grievance','/terms','/privacy']) assert(footer.includes('href="' + href + '"'), 'Organiser footer keeps ' + href);
assert.match(html, /name="robots" content="noindex, nofollow"/, '/organisers is archived (noindex)');
console.log('/organisers approved folk design and complete footer passed.');
