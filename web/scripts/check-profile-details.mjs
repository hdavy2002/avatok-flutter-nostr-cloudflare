// [CALLVAAL-CATEGORY-DETAILS-1] Built HTML contract; run after the CI web build.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeBuiltImages } from './built-image-source.mjs';

const root = resolve('dist');
const home = readFileSync(resolve(root, 'index.html'), 'utf8');
const identity = JSON.parse(readFileSync(resolve('../Specs/brand.json'), 'utf8')).homepageIdentity;
const profiles = [
  ['dr-ananya', 'Dr. Ananya', 'doctors', 25, 'Hindi, English', ['portrait-1', 'doctor-notes', 'doctor-consultation']],
  ['sana', 'Sana', 'counsellor', 15, 'Hindi, English', ['portrait-5', 'sana-notes', 'sana-conversation']],
  ['neha', 'Neha', 'listener', 10, 'Hindi, Marathi', ['portrait-7', 'neha-tea', 'neha-conversation']],
  ['kavya', 'Kavya', 'astrology', 15, 'Hindi, Kannada', ['portrait-6', 'kavya-chart', 'kavya-tarot']],
  ['priya', 'Priya', 'practice', 15, 'Hindi, English', ['portrait-9', 'priya-practice', 'priya-interview']],
];
const boundaries = {
  sana: ['No credentials or clinical services have been verified.', 'Not emergency or crisis care.'],
  neha: ['Listening and companionship only.', 'Not therapy, medical advice or crisis support.'],
  kavya: ['For reflection and entertainment.', 'No guaranteed predictions or outcomes;', 'not medical, legal or financial advice.'],
  priya: ['Practice and feedback only.', 'No job, interview, exam or fluency outcomes are guaranteed.'],
};
const text = html => html.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ').replaceAll('&amp;', '&').replace(/\s+/g, ' ').trim();
const cards = [...home.matchAll(/<article\b[^>]*\bdata-person(?:="")?[^>]*>[\s\S]*?<\/article>/g)].map(match => match[0]);
for (const [id, name, category, rate, languages, assets] of profiles) {
  const path = `/people/${id}`;
  // Reverse CI's immutable image URLs through its generated manifest, validating
  // the emitted hash and original bytes before comparing fixture asset identity.
  // This also normalizes the inert gallery JSON and keeps doctor-leak checks useful.
  const html = normalizeBuiltImages(readFileSync(resolve(root, `people/${id}/index.html`), 'utf8'), { root });
  const main = html.match(/<main\b[^>]*id="profile-main"[^>]*>[\s\S]*?<\/main>/)?.[0];
  assert(main, `${id}: shared profile main`);
  assert(html.includes(`<title>${name} — `) && html.includes(`| ${identity.name}</title>`), `${id}: category title with central identity`);
  assert.match(html, /<meta\b[^>]*name="robots"[^>]*content="noindex,nofollow"/, `${id}: sample stays noindex`);
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1, `${id}: one h1`);
  assert.equal((html.match(/<header\b[^>]*data-callvaal-chrome/g) || []).length, 1, `${id}: shared header`);
  assert.equal((html.match(/<footer\b[^>]*data-callvaal-chrome/g) || []).length, 1, `${id}: shared footer`);
  for (const [key, value] of [['id', id], ['category', category], ['path', path]]) assert(main.includes(`data-profile-${key}="${value}"`), `${id}: interaction ${key}`);
  assert(main.includes(`href="/?category=${category}#people"`), `${id}: correct category breadcrumb`);
  assert(text(main).includes(name) && text(main).includes(languages), `${id}: matching identity and languages`);
  assert.equal((html.match(new RegExp(`₹${rate}/min`, 'g')) || []).length, 2, `${id}: desktop and mobile price`);
  for (const section of ['about', 'services', 'reviews', 'gallery']) {
    assert(main.includes(`id="${section}"`) && main.includes(`href="#${section}"`), `${id}: ${section} section and anchor`);
  }
  assert.equal((main.match(/class="cv-review-card"/g) || []).length, 2, `${id}: two sample reviews`);
  assert.match(main, /class="cv-sample-disclosure"/, `${id}: visible sample disclosure`);
  assert.match(text(main), /illustrative/i, `${id}: honest sample copy`);
  assert.match(html, /Calling, booking and payments are not available\./, `${id}: preview-only transaction boundary`);
  for (const hook of ['data-profile-save', 'data-profile-share', 'data-profile-preview="call"', 'data-profile-preview="book"']) assert(html.includes(hook), `${id}: ${hook}`);
  for (const dialog of ['cv-profile-preview', 'cv-gallery-dialog', 'cv-share-dialog']) assert(html.includes(`id="${dialog}"`), `${id}: ${dialog}`);
  assert.doesNotMatch(main, /href="(?:tel:|\/checkout|\/consult\/book)/, `${id}: no live call or checkout`);
  const gallery = JSON.parse(html.match(/<script\b[^>]*id="cv-gallery-data"[^>]*>([\s\S]*?)<\/script>/)?.[1] || 'null');
  assert.equal(gallery?.length, 3, `${id}: three gallery items`);
  for (const [index, asset] of assets.entries()) {
    assert(existsSync(resolve(root, `assets/callvaal/scrapbook/${asset}.png`)), `${id}: shipped ${asset}`);
    assert.equal(gallery[index].src, `/assets/callvaal/scrapbook/${asset}.png`, `${id}: gallery order ${index}`);
    assert(gallery[index].alt.includes(name) && gallery[index].width > 0 && gallery[index].height > 0, `${id}: labelled image dimensions`);
  }
  const card = cards.find(card => card.includes(`href="${path}"`));
  assert(card, `${id}: homepage discovery card`);
  assert.equal((card.match(new RegExp(`href="${path}"`, 'g')) || []).length, 3, `${id}: portrait, name and primary action reach detail`);
  assert(card.includes(`data-category="${category}"`) && text(card).includes(`₹${rate}/min`) && text(card).includes(languages), `${id}: homepage/category/rate/languages agree`);
  if (id === 'dr-ananya') {
    for (const preserved of ['General physician', 'NMC', '5+ years experience', '4.8', '42 reviews', 'Talked to 120 people', 'Next available 4:30 PM']) assert(text(main).includes(preserved), `doctor regression: ${preserved}`);
  } else {
    for (const boundary of boundaries[id]) assert(text(main).includes(boundary) && text(html.match(/<dialog\b[^>]*id="cv-profile-preview"[^>]*>[\s\S]*?<\/dialog>/)?.[0] || '').includes(boundary), `${id}: category boundary in page and preview`);
    assert.doesNotMatch(main, /Dr\. Ananya|General physician|NMC|RCI|doctor-notes|doctor-consultation|lab reports|prescriptions|NMC verified/i, `${id}: no copied doctor content or invented credentials`);
    assert.doesNotMatch(main, /class="cv-(?:verified|online|next-slot|review-summary|review-stars)"|years experience|Talked to \d+ people/, `${id}: unsupported credentials, availability and metrics omitted`);
    assert.equal((main.match(/class="cv-review-sample"/g) || []).length, 2, `${id}: each fictional review visibly labelled`);
    assert.doesNotMatch(card, /class="verification-badge"/, `${id}: no invented homepage badge`);
  }
}
console.log('Five sample profile contracts passed: routes, discovery, category boundaries, gallery and doctor regression.');
