import type { PublicContent } from './types';
import { BRAND } from '../brand';

export const MARKETPLACE_SEO: PublicContent = {
  kind: 'collection',
  key: 'marketplace',
  canonicalPath: '/marketplace',
  title: `Havans & Pujas at Himalayan Temples · ${BRAND.name}`,
  summary: 'Book havans and pujas performed by pujaris at positive Himalayan temples. Filter by deity, wish, date or price; your sankalp in your name and gotra, the video filmed by our crew, dry prasad delivered to your door.',
  visibility: 'public',
  image: { url: '/assets/saathum-grand/hero.png', alt: `Havans and pujas at Himalayan temples — ${BRAND.name}.` },
};

// [WEB-HIW-2 2026-09-27] /how-it-works moved off layouts/Content.astro onto the
// folk shell. These are the exact values Content.astro used to derive from the
// page's props (title / description / updated / default og image), kept so the
// page's title, canonical, summary and social card do not change.
export const HOW_IT_WORKS_SEO: PublicContent = {
  kind: 'page',
  key: '/how-it-works',
  canonicalPath: '/how-it-works',
  title: 'How we perform your havan at a Himalayan temple',
  summary: 'How our crew travels to a Himalayan temple, how the pujari performs your havan or puja in your name and gotra, live streaming and the full video, weather delays and same-day dry prasad.',
  visibility: 'public',
  modifiedAt: new Date('2026-09-27').toISOString(),
  image: { url: '/og-editorial.png', alt: `How we perform your havan at a Himalayan temple — ${BRAND.name}` },
};

// [WEB-TEMPLES-1 2026-09-29] /temples — "Our temples" (header + footer menus).
export const TEMPLES_SEO: PublicContent = {
  kind: 'page',
  key: '/temples',
  canonicalPath: '/temples',
  title: 'Our temples — Haridwar, Rishikesh, Kedarnath, Badrinath & Himachal',
  summary: `The temples ${BRAND.name} works with across Uttarakhand and Himachal. Our team visits with a camera crew and live streams your puja, sends the full video if the network drops, and ships dry prasad the same day.`,
  visibility: 'public',
  modifiedAt: new Date('2026-09-29').toISOString(),
  image: { url: '/og-editorial.png', alt: `The temples we work with — ${BRAND.name}` },
};

export const HELP_SEO: PublicContent = {
  kind: 'collection',
  key: 'help',
  canonicalPath: '/help',
  title: 'Help centre',
  summary: `Guides for booking and paying for pujas and havans on ${BRAND.name} — search or browse by topic.`,
  visibility: 'public',
};
