import type { PublicContent } from './types';

export const MARKETPLACE_SEO: PublicContent = {
  kind: 'collection',
  key: 'marketplace',
  canonicalPath: '/marketplace',
  title: 'Pujas, Havans & Satsang — live from temples · Saa Thum',
  summary: 'Search and book live pujas, havans, satsang, sermons and meditation, performed by temple priests. Filter by deity, wish, date or price; your sankalp in your name and gotra, watched live from anywhere, prasad delivered to your door.',
  visibility: 'public',
  image: { url: '/assets/saathum-grand/hero.png', alt: 'Pujas and havans performed live by Saa Thum priests.' },
};

// [WEB-HIW-2 2026-09-27] /how-it-works moved off layouts/Content.astro onto the
// folk shell. These are the exact values Content.astro used to derive from the
// page's props (title / description / updated / default og image), kept so the
// page's title, canonical, summary and social card do not change.
export const HOW_IT_WORKS_SEO: PublicContent = {
  kind: 'page',
  key: '/how-it-works',
  canonicalPath: '/how-it-works',
  title: 'Performed for you, in three simple steps',
  summary: 'How Saa Thum performs a puja or havan in your name and gotra while you watch live — plus puja vs havan, and answers to common questions.',
  visibility: 'public',
  modifiedAt: new Date('2026-09-27').toISOString(),
  image: { url: '/og-editorial.png', alt: 'Performed for you, in three simple steps — Saa Thum' },
};

export const HELP_SEO: PublicContent = {
  kind: 'collection',
  key: 'help',
  canonicalPath: '/help',
  title: 'Help centre',
  summary: 'Guides for booking and paying for pujas and havans on Saa Thum — search or browse by topic.',
  visibility: 'public',
};
