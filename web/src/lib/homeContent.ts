import type { PublicContent } from './seo/types';

export const HOME_HERO = {
  eyebrow: 'HAVANS · OPEN TO ALL',
  titleLineOne: 'Sab ki aahuti,',
  titleLineTwo: 'sab ka ashirwad.',
  lead: 'Join havans for health, prosperity, peace and new beginnings, performed by our priests for devotees everywhere.',
  proof: 'Sankalp in your name · Video to download · Prasad at your door.',
} as const;

export const HOME_SEO: PublicContent = {
  kind: 'home',
  key: 'home',
  canonicalPath: '/',
  title: 'Book Havans & Pujas Online | Saa Thum',
  summary: 'Join havans for health, prosperity, peace and new beginnings. Our priests perform your sankalp, we send you the video to download, and prasad comes to your home.',
  visibility: 'public',
  image: {
    url: '/assets/saathum-grand/hero.png',
    alt: 'Saa Thum havans and pujas, with the video and prasad delivered to you.',
    revision: 'saathum-home-v1',
  },
};
