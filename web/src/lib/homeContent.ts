import type { PublicContent } from './seo/types';
import { BRAND } from './brand';

export const HOME_HERO = {
  // [WEB-REFRAME-1 2026-09-29] OWNER: reframe around Himalayan temple havans (plan option A).
  // Previous: 'HAVANS · OPEN TO ALL' / 'Sab ki aahuti,' / 'sab ka ashirwad.'
  eyebrow: 'HIMALAYAN TEMPLE HAVANS',
  // [WEB-HERO-PHOTO-1 2026-09-29] OWNER copy.
  titleLineOne: 'Your Puja,',
  titleLineTwo: 'in the Peaceful Himalayas.',
  lead: `Living abroad or unable to travel? ${BRAND.name} arranges puja and havan in your name at peaceful Himalayan temples, where people have come to pray for generations — helping you stay connected to your faith from home.`,
  proof: 'One sankalp for every devotee · Filmed at the temple · Prasad at your door.',
} as const;

export const HOME_SEO: PublicContent = {
  kind: 'home',
  key: 'home',
  canonicalPath: '/',
  title: `Himalayan Temple Havans in Your Name | ${BRAND.name}`,
  summary: 'Living abroad or unable to travel? We arrange puja and havan in your name at peaceful Himalayan temples, so you stay connected to your faith.',
  visibility: 'public',
  image: {
    // [WEB-OG-SHARE-1] The homepage's actual hero photo (WEB-HERO-PHOTO-1), so a
    // shared saathum.com link previews with the same picture visitors see first.
    url: '/assets/grand/hero-havan.jpg',
    alt: 'Our crew filming a havan at a Himalayan temple at dawn, the pujari offering ghee into the fire with snow peaks behind.',
    revision: 'home-v3',
  },
};
