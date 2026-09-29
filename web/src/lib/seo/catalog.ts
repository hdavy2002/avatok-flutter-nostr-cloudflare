import type { PublicContent } from './types';

export const MARKETPLACE_SEO: PublicContent = {
  kind: 'collection',
  key: 'marketplace',
  canonicalPath: '/marketplace',
  title: 'Pujas, Havans & Satsang — performed by temple priests · Saa Thum',
  summary: 'Search and book pujas, havans, satsang, sermons and meditation, performed by temple priests. Filter by deity, wish, date or price; your sankalp in your name and gotra, the video sent to you, prasad delivered to your door.',
  visibility: 'public',
  image: { url: '/assets/saathum-grand/hero.png', alt: 'Pujas and havans performed by Saa Thum priests.' },
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
  summary: 'How Saa Thum performs a puja or havan in your name and gotra and sends you the video — plus puja vs havan, and answers to common questions.',
  visibility: 'public',
  modifiedAt: new Date('2026-09-27').toISOString(),
  image: { url: '/og-editorial.png', alt: 'Performed for you, in three simple steps — Saa Thum' },
};

// [WEB-TEMPLES-1 2026-09-29] /temples — "Our temples" (header + footer menus).
export const TEMPLES_SEO: PublicContent = {
  kind: 'page',
  key: '/temples',
  canonicalPath: '/temples',
  title: 'Our temples — Haridwar, Rishikesh, Kedarnath, Badrinath & Himachal',
  summary: 'The temples Saa Thum works with across Uttarakhand and Himachal. Our team visits with a camera crew and live streams your puja, sends the full video if the network drops, and ships dry prasad the same day.',
  visibility: 'public',
  modifiedAt: new Date('2026-09-29').toISOString(),
  image: { url: '/og-editorial.png', alt: 'The temples we work with — Saa Thum' },
};

export const HELP_SEO: PublicContent = {
  kind: 'collection',
  key: 'help',
  canonicalPath: '/help',
  title: 'Help centre',
  summary: 'Guides for booking and paying for pujas and havans on Saa Thum — search or browse by topic.',
  visibility: 'public',
};
