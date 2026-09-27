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

export const HELP_SEO: PublicContent = {
  kind: 'collection',
  key: 'help',
  canonicalPath: '/help',
  title: 'Help centre',
  summary: 'Guides for booking and paying for pujas and havans on Saa Thum — search or browse by topic.',
  visibility: 'public',
};
