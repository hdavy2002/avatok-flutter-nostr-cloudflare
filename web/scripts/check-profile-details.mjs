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
  assert(title.startsWith(`${name} — Someone to talk to `) && title.includes(`| ${identity.name}`) && title.endsWith(`· ${brand.name}`), `${id}: conversation title with homepage and site identities`);
  const robots = html.match(/<meta\b[^>]*name="robots"[^>]*>/)?.[0] || '';
  assert.match(robots, /content="noindex,\s*follow"/, `${id}: sample stays noindex while allowing link discovery`);
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1, `${id}: one h1`);
  assert.equal((html.match(/<header\b[^>]*data-callvaal-chrome/g) || []).length, 1, `${id}: shared header`);
  assert.equal((html.match(/<footer\b[^>]*data-callvaal-chrome/g) || []).length, 1, `${id}: shared footer`);
  for (const [key, value] of [['id', id], ['name', name], ['path', path]]) assert(main.includes(`data-profile-${key}="${value}"`), `${id}: interaction ${key}`);
  assert(main.includes('href="/#people"'), `${id}: people breadcrumb`);
  assert(text(main).includes(name) && text(main).includes(languages), `${id}: matching identity and languages`);
  assert.equal((html.match(new RegExp(`₹${rate}/min`, 'g')) || []).length, 2, `${id}: desktop and mobile price`);
  for (const section of ['about', 'moods', 'reviews']) {
    assert(main.includes(`id="${section}"`) && main.includes(`href="#${section}"`), `${id}: ${section} section and anchor`);
  }
  assert.equal((main.match(/class="cv-review-card"/g) || []).length, 2, `${id}: two sample reviews`);
  assert.match(main, /class="cv-sample-disclosure"/, `${id}: visible sample disclosure`);
  assert.match(text(main), /illustrative/i, `${id}: honest sample copy`);
  assert.match(html, /Calls, bookings and payments are unavailable\./, `${id}: preview-only transaction boundary`);
  for (const hook of ['data-profile-save', 'data-profile-share', 'data-profile-preview="call"', 'data-profile-preview="book"']) assert(html.includes(hook), `${id}: ${hook}`);
  for (const dialog of ['cv-profile-preview', 'cv-gallery-dialog', 'cv-share-dialog']) assert(html.includes(`id="${dialog}"`), `${id}: ${dialog}`);
  assert.doesNotMatch(main, /href="(?:tel:|\/checkout|\/consult\/book)/, `${id}: no live call or checkout`);
  const gallery = JSON.parse(html.match(/<script\b[^>]*id="cv-gallery-data"[^>]*>([\s\S]*?)<\/script>/)?.[1] || 'null');
  assert.deepEqual(gallery, [], `${id}: retired professional galleries are absent`);
  assert(!main.includes('id="gallery"'), `${id}: no empty gallery section`);
  assert(existsSync(resolve(root, `assets/callvaal/scrapbook/${portrait}.png`)), `${id}: approved portrait ships`);
  assert(main.includes(`/assets/callvaal/scrapbook/${portrait}.png`), `${id}: correct host portrait`);
  const card = cards.find(card => card.includes(`href="${path}"`));
  assert(card, `${id}: homepage discovery card`);
  assert.equal((card.match(new RegExp(`href="${path}"`, 'g')) || []).length, 2, `${id}: name and primary action reach detail`);
  assert(card.includes('data-moods=') && text(card).includes(`₹${rate}/min`) && text(card).includes(languages), `${id}: homepage mood/rate/languages agree`);
  const detailMoods = [...main.matchAll(/<ul\b[^>]*class="cv-topic-tags"[^>]*>([\s\S]*?)<\/ul>/g)].flatMap(match => [...match[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(item => text(item[1])));
  assert(detailMoods.length >= 2, `${id}: everyday conversation topics`);
  for (const mood of detailMoods) assert(text(card).includes(mood), `${id}: mood agrees with homepage: ${mood}`);
  assert.doesNotMatch(main, /Dr\. Ananya|General physician|NMC|RCI|doctor-notes|doctor-consultation|lab reports|prescriptions|years experience|id="services"/i, `${id}: no professional framing`);
  assert.equal((main.match(/class="cv-review-sample"/g) || []).length, 2, `${id}: each fictional review labelled`);
  const preview = text(html.match(/<dialog\b[^>]*id="cv-profile-preview"[^>]*>[\s\S]*?<\/dialog>/)?.[0] || '');
  for (const boundary of ['No medical, legal or money advice.', 'No miracles, no guaranteed results.', '18+ only.']) assert(text(main).includes(boundary) && preview.includes(boundary), `${id}: page and call disclaimer: ${boundary}`);
  assert.match(html, /data-disclaimer-ack/, `${id}: explicit disclaimer acknowledgement`);
}
console.log('Five mood-led sample profile contracts passed: discovery, identity, prices, topics and safety boundaries.');
