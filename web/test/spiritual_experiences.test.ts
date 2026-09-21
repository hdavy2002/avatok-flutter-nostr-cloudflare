// [SHV2-S5] Regression tests for the 13-topic "explore spiritual experiences"
// data module (contracts.md §1 / spec A4.4).
//
// node:test based, matching the convention already used by this repo's
// web/test/ (see calendar_core.test.ts — there is no vitest devDependency in
// web/package.json). Run with:
//   node --experimental-strip-types --test web/test/spiritual_experiences.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { SPIRITUAL_TOPICS, topicSearchHref, type SpiritualTopic } from '../src/lib/spiritualExperiences.ts';

const EXPECTED: Array<Pick<SpiritualTopic, 'id' | 'title' | 'searchTerm'>> = [
  { id: 'satsang', title: 'Satsang & Spiritual Talks', searchTerm: 'Satsang' },
  { id: 'bhajan-kirtan', title: 'Bhajan & Kirtan', searchTerm: 'Bhajan' },
  { id: 'puja-archana', title: 'Puja & Archana', searchTerm: 'Puja' },
  { id: 'havan-yajna', title: 'Havan & Yajna', searchTerm: 'Havan' },
  { id: 'aarti-darshan', title: 'Aarti & Darshan', searchTerm: 'Aarti' },
  { id: 'katha', title: 'Katha & Sacred Stories', searchTerm: 'Katha' },
  { id: 'scripture-study', title: 'Scripture Study & Discussion', searchTerm: 'Bhagavad Gita' },
  { id: 'mantra-japa', title: 'Mantra, Japa & Recitation', searchTerm: 'Mantra' },
  { id: 'yoga-pranayama', title: 'Yoga & Pranayama', searchTerm: 'Yoga' },
  { id: 'meditation', title: 'Meditation & Inner Practice', searchTerm: 'Meditation' },
  { id: 'festivals', title: 'Festivals & Special Observances', searchTerm: 'Festival' },
  { id: 'pilgrimage', title: 'Pilgrimage & Sacred Places', searchTerm: 'Temple' },
  { id: 'hindu-traditions', title: 'Learn Hindu Traditions', searchTerm: 'Hindu traditions' },
];

test('all 13 topics are present, in order, matching the contract table', () => {
  assert.equal(SPIRITUAL_TOPICS.length, 13);
  SPIRITUAL_TOPICS.forEach((topic, i) => {
    assert.equal(topic.id, EXPECTED[i].id);
    assert.equal(topic.title, EXPECTED[i].title);
    assert.equal(topic.searchTerm, EXPECTED[i].searchTerm);
  });
});

test('no duplicate ids', () => {
  const ids = SPIRITUAL_TOPICS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every topic has a non-empty attendee blurb and organiser idea', () => {
  for (const topic of SPIRITUAL_TOPICS) {
    assert.ok(topic.blurb.trim().length > 0, `${topic.id} blurb is empty`);
    assert.ok(topic.organiserIdea.trim().length > 0, `${topic.id} organiserIdea is empty`);
    assert.notEqual(topic.blurb, topic.organiserIdea, `${topic.id} organiser voice must differ from attendee voice`);
  }
});

test('topicSearchHref encodes plain single-word terms', () => {
  const satsang = SPIRITUAL_TOPICS.find((t) => t.id === 'satsang')!;
  assert.equal(topicSearchHref(satsang), '/marketplace?q=Satsang');
});

test('topicSearchHref percent-encodes spaces in multi-word terms', () => {
  const gita = SPIRITUAL_TOPICS.find((t) => t.id === 'scripture-study')!;
  assert.equal(topicSearchHref(gita), '/marketplace?q=Bhagavad%20Gita');

  const traditions = SPIRITUAL_TOPICS.find((t) => t.id === 'hindu-traditions')!;
  assert.equal(topicSearchHref(traditions), '/marketplace?q=Hindu%20traditions');
});

test('no topic id looks like a backend category id (the live-event allowlist prefix)', () => {
  for (const topic of SPIRITUAL_TOPICS) {
    assert.ok(!topic.id.startsWith('live_'), `${topic.id} looks like a category id, not an editorial slug`);
  }
});
