import type { PublicContent } from './seo/types';

export const HOME_HERO = {
  eyebrow: 'LIVE HAVANS · OPEN TO ALL',
  titleLineOne: 'Sab ki aahuti,',
  titleLineTwo: 'sab ka ashirwad.',
  lead: 'Join live havans for health, prosperity, peace and new beginnings, performed by our priests and shared with devotees everywhere.',
  proof: 'Watch live · 7-day replay · Prasad at your door.',
} as const;

export const HOME_SEO: PublicContent = {
  kind: 'home',
  key: 'home',
  canonicalPath: '/',
  title: 'Join Live Havans & Pujas Online | Saathum',
  summary: 'Join live havans for health, prosperity, peace and new beginnings. Our priests perform your sankalp. Watch live, replay for 7 days and receive prasad at home.',
  visibility: 'public',
  image: {
    url: '/assets/saathum-grand/hero.png',
    alt: 'Saathum live havans and pujas, watched online with prasad delivered at home.',
    revision: 'saathum-home-v1',
  },
};
