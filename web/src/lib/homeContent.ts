import type { PublicContent } from './seo/types';

export const HOME_HERO = {
  // [WEB-REFRAME-1 2026-09-29] OWNER: reframe around Himalayan temple havans (plan option A).
  // Previous: 'HAVANS · OPEN TO ALL' / 'Sab ki aahuti,' / 'sab ka ashirwad.'
  eyebrow: 'HIMALAYAN TEMPLE HAVANS',
  titleLineOne: 'Deep in the Himalayas,',
  titleLineTwo: 'your havan, in your name.',
  lead: 'Our crew travels to peaceful hill temples of Shiva, Vishnu, Ram and the Himalayan Devis. The temple\'s own pujari performs your havan with your sankalp, and we film it for you.',
  proof: 'Sankalp in your name · Filmed at the temple · Prasad at your door.',
} as const;

export const HOME_SEO: PublicContent = {
  kind: 'home',
  key: 'home',
  canonicalPath: '/',
  title: 'Himalayan Temple Havans in Your Name | Saa Thum',
  summary: 'Havans in your name at peaceful Himalayan temples, filmed by our crew, with dry prasad to your door. Every booking supports mountain pujaris.',
  visibility: 'public',
  image: {
    url: '/assets/saathum-grand/hero.png',
    alt: 'Saa Thum havans and pujas, with the video and prasad delivered to you.',
    revision: 'saathum-home-v1',
  },
};
