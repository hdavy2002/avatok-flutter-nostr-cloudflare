// [CALLVAAL-CATEGORY-DETAILS-1] Built HTML contract; run after the CI web build.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeBuiltImages } from './built-image-source.mjs';

const root = resolve('dist');
const home = readFileSync(resolve(root, 'index.html'), 'utf8');
const brand = JSON.parse(readFileSync(resolve('../Specs/brand.json'), 'utf8'));
const identity = brand.homepageIdentity;
const profiles = [
  ['dr-ananya', 'Ananya', 20, 'Hindi, English', 'portrait-ananya'],
  ['sana', 'Sana', 25, 'Hindi, English', 'portrait-5'],
  ['neha', 'Neha', 20, 'Hindi, Marathi', 'portrait-7'],
  ['kavya', 'Kavya', 30, 'Hindi, Kannada', 'portrait-6'],
  ['priya', 'Priya', 25, 'Hindi, English', 'portrait-9'],
  ['rohan', 'Rohan', 20, 'Hindi, English', 'portrait-3'],
  ['arjun', 'Arjun', 25, 'Hindi, English', 'portrait-4'],
  ['dev', 'Dev', 30, 'English, Hindi', 'portrait-8'],
];
const decodeEntities = value => value
  .replace(/&#(\d+);/g, (_match, codePoint) => String.fromCodePoint(Number(codePoint)))
  .replace(/&#x([\da-f]+);/gi, (_match, codePoint) => String.fromCodePoint(Number.parseInt(codePoint, 16)))
  .replaceAll('&amp;', '&')
  .replaceAll('&quot;', '"')
  .replaceAll('&#39;', "'")
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>');
const text = html => decodeEntities(html.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const cards = [...home.matchAll(/<article\b[^>]*\bdata-person(?:="")?[^>]*>[\s\S]*?<\/article>/g)].map(match => match[0]);
for (const [id, name, rate, languages, portrait] of profiles) {
  const path = `/people/${id}`;
  // Reverse CI's immutable image URLs through its generated manifest, validating
  // the emitted hash and original bytes before comparing fixture asset identity.
  // This also normalizes the inert gallery JSON and keeps doctor-leak checks useful.
  const html = normalizeBuiltImages(readFileSync(resolve(root, `people/${id}/index.html`), 'utf8'), { root });
  const main = html.match(/<main\b[^>]*id="profile-main"[^>]*>[\s\S]*?<\/main>/)?.[0];
  assert(main, `${id}: shared profile main`);
  const title = text(html.match(/<title\b[^>]*>[\s\S]*?<\/title>/)?.[0] || '');
  assert.equal(title, `${name} — Someone to talk to | ${identity.name}`, `${id}: conversation title uses only the public identity`);
  const robots = html.match(/<meta\b[^>]*name="robots"[^>]*>/)?.[0] || '';
  assert.match(robots, /content="noindex,\s*follow"/, `${id}: sample stays noindex while allowing link discovery`);
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1, `${id}: one h1`);
  const canonical = html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/)?.[1];
  assert(canonical, `${id}: canonical URL exists`);
  const canonicalUrl = new URL(canonical);
  assert.equal(canonicalUrl.origin, `https://${identity.domain}`, `${id}: Hello Fraands canonical domain`);
  assert.equal(canonicalUrl.pathname.replace(/\/$/, ''), path, `${id}: canonical profile path`);
  const ogUrl = html.match(/<meta\b[^>]*property="og:url"[^>]*content="([^"]+)"/)?.[1];
  assert.equal(ogUrl, canonical, `${id}: OG URL matches canonical`);
  const metadata = key => {
    const tag = (html.match(/<meta\b[^>]*>/g) || []).find(tag => tag.includes(`property="${key}"`) || tag.includes(`name="${key}"`));
    return decodeEntities(tag?.match(/content="([^"]*)"/)?.[1] || '');
  };
  assert.equal(metadata('og:site_name'), identity.name, `${id}: OG site identity`);
  assert.equal(metadata('og:title'), title, `${id}: OG title matches page title`);
  assert.equal(metadata('twitter:title'), title, `${id}: Twitter title matches page title`);
  const ogImage = metadata('og:image');
  assert(ogImage, `${id}: OG image exists`);
  assert.equal(new URL(ogImage).origin, `https://${identity.domain}`, `${id}: OG image domain`);
  assert.equal(metadata('og:image:secure_url'), ogImage, `${id}: secure OG image matches`);
  assert.equal(metadata('twitter:image'), ogImage, `${id}: Twitter image matches`);

  assert.doesNotMatch(text(html), /CallVaal/, `${id}: retired visible brand absent`);

  assert.equal((html.match(/<header\b[^>]*data-callvaal-chrome/g) || []).length, 1, `${id}: shared header`);
  assert.equal((html.match(/<footer\b[^>]*data-callvaal-chrome/g) || []).length, 1, `${id}: shared footer`);
  for (const [key, value] of [['id', id], ['name', name], ['path', path]]) assert(main.includes(`data-profile-${key}="${value}"`), `${id}: interaction ${key}`);
  assert(main.includes('href="/marketplace"'), `${id}: Explore breadcrumb`);
  assert(text(main).includes(name) && text(main).includes(languages), `${id}: matching identity and languages`);
  assert.equal((html.match(new RegExp(`₹${rate}/min`, 'g')) || []).length, 2, `${id}: desktop and mobile price`);
  for (const section of ['about', 'moods', 'reviews']) {
    assert(main.includes(`id="${section}"`) && main.includes(`href="#${section}"`), `${id}: ${section} section and anchor`);
  }
  // [HF-PROFILE-DETAIL-2] five sample reviews, a star breakdown, and a demo review form.
  const reviewCount = (main.match(/class="cv-review-card"/g) || []).length;
  assert(reviewCount >= 5, `${id}: at least five sample reviews`);
  assert.equal((main.match(/<ul\b[^>]*class="cv-rating-bars"[^>]*>[\s\S]*?<\/ul>/)?.[0].match(/<li\b/g) || []).length, 5, `${id}: 5-to-1 star breakdown`);
  assert(html.includes('id="cv-review-dialog"') && main.includes('data-review-open') && html.includes('data-review-form'), `${id}: write-a-review demo`);
  assert.match(text(html.match(/<dialog\b[^>]*id="cv-review-dialog"[^>]*>[\s\S]*?<\/dialog>/)?.[0] || ''), /not saved/, `${id}: review form says it is a demo`);
  // [HF-PROFILE-DETAIL-2] every card field also appears on the detail page.
  assert(main.includes('data-voice') && /Hear my introduction/.test(text(main)), `${id}: voice introduction`);
  assert(text(main).includes(`have talked to ${name}`), `${id}: talked-to count`);
  assert(/Conversation style/.test(text(main)) && !/Details coming soon/.test(text(main)), `${id}: conversation style filled`);
  assert.equal((html.match(new RegExp(`10 min ≈ ₹${rate * 10}`, 'g')) || []).length, 2, `${id}: desktop and mobile 10-minute estimate`);
  assert.match(main, /class="cv-sample-disclosure"/, `${id}: visible sample disclosure`);
  assert.match(text(main), /illustrative/i, `${id}: honest sample copy`);
  assert.match(html, /Calls, bookings and payments are unavailable\./, `${id}: preview-only transaction boundary`);
  assert(/data-profile-preview="(?:call|notify)"/.test(html), `${id}: call or notify follows availability`);
  for (const hook of ['data-profile-save', 'data-profile-share', 'data-profile-preview="book"']) assert(html.includes(hook), `${id}: ${hook}`);
  for (const dialog of ['cv-profile-preview', 'cv-gallery-dialog', 'cv-share-dialog']) assert(html.includes(`id="${dialog}"`), `${id}: ${dialog}`);
  assert.doesNotMatch(main, /href="(?:tel:|\/checkout|\/consult\/book)/, `${id}: no live call or checkout`);
  const gallery = JSON.parse(html.match(/<script\b[^>]*id="cv-gallery-data"[^>]*>([\s\S]*?)<\/script>/)?.[1] || 'null');
  assert.deepEqual(gallery, [], `${id}: retired professional galleries are absent`);
  assert(!main.includes('id="gallery"'), `${id}: no empty gallery section`);
  assert(existsSync(resolve(root, `assets/callvaal/scrapbook/${portrait}.png`)), `${id}: approved portrait ships`);
  assert(main.includes(`/assets/callvaal/scrapbook/${portrait}.png`), `${id}: correct host portrait`);
  const card = cards.find(card => card.includes(`href="${path}"`));
  assert(card, `${id}: homepage discovery card`);
  // [PROFILE-CARD-CHECK-1 2026-10-08] The approved photo cards ([LISTENER-PHOTO-CARDS-1]) link the name AND a
  // "View full profile" line to the detail page; the primary button still follows availability (next check).
  assert.equal((card.match(new RegExp(`href="${path}"`, 'g')) || []).length, 2, `${id}: name and View full profile reach detail while primary button follows availability`);
  assert.match(card, /data-preview-action="(?:call|notify)"/, `${id}: truthful preview action`);
  if (id === 'kavya') assert.doesNotMatch(text(main), /kundli|horoscope|tarot|Taare/i, 'Kavya now offers everyday conversation topics');
  assert(card.includes('data-moods=') && text(card).includes(`₹${rate}/min`) && text(card).includes(languages), `${id}: homepage mood/rate/languages agree`);
  const detailMoods = [...main.matchAll(/<ul\b[^>]*class="cv-detail-topics"[^>]*>([\s\S]*?)<\/ul>/g)].flatMap(match => [...match[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(item => text(item[1])));
  assert(detailMoods.length >= 2, `${id}: everyday conversation topics`);
  for (const mood of detailMoods) assert(text(card).includes(mood), `${id}: mood agrees with homepage: ${mood}`);
  assert.doesNotMatch(main, /Dr\. Ananya|General physician|NMC|RCI|doctor-notes|doctor-consultation|lab reports|prescriptions|years experience|id="services"/i, `${id}: no professional framing`);
  assert.equal((main.match(/Illustrative review/g) || []).length, reviewCount, `${id}: each fictional review labelled`);
  const preview = text(html.match(/<dialog\b[^>]*id="cv-profile-preview"[^>]*>[\s\S]*?<\/dialog>/)?.[0] || '');
  for (const boundary of ['No medical, legal or money advice.', 'No miracles, no guaranteed results.', '18+ only.']) assert(text(main).includes(boundary) && preview.includes(boundary), `${id}: page and call disclaimer: ${boundary}`);
  assert.match(html, /data-disclaimer-ack/, `${id}: explicit disclaimer acknowledgement`);
}
console.log(`${profiles.length} mood-led sample profile contracts passed: discovery, identity, prices, topics and safety boundaries.`);
