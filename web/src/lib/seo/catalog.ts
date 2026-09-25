import type { PublicContent } from './types';

export const MARKETPLACE_SEO: PublicContent = {
  kind: 'collection',
  key: 'marketplace',
  canonicalPath: '/marketplace',
  title: 'Our Pujas & Havans · Saathum',
  summary: 'Choose a puja or havan for studies, a fresh start, prosperity, health, family or peace. Our priests perform it in your name and gotra while you watch live. Prasad delivered to your door.',
  visibility: 'public',
  image: { url: '/assets/saathum-grand/hero.png', alt: 'Pujas and havans performed live by Saathum priests.' },
};

export const HELP_SEO: PublicContent = {
  kind: 'collection',
  key: 'help',
  canonicalPath: '/help',
  title: 'Help centre',
  summary: 'Guides for booking and paying for pujas and havans on Saathum — search or browse by topic.',
  visibility: 'public',
};
