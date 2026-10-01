import type { PublicContent } from './seo/types';
import { BRAND } from './brand';

export const HOME_HERO = {
  // [WEB-REFRAME-1 2026-09-29] OWNER: reframe around Himalayan temple havans (plan option A).
  // Previous: 'HAVANS · OPEN TO ALL' / 'Sab ki aahuti,' / 'sab ka ashirwad.'
  // [AUMFE-COPY-SEO-1 2026-10-01] Fresh wording for the brand's own site. Previous: 'HIMALAYAN TEMPLE HAVANS'.
  eyebrow: 'HAVANS AT HIMALAYAN TEMPLES',
  // [WEB-HERO-PHOTO-1 2026-09-29] OWNER copy.
  titleLineOne: 'A puja in your name,',
  titleLineTwo: 'at a quiet Himalayan temple.',
  lead: `Far from India, or unable to make the journey? ${BRAND.name} has your havan or puja performed by the pujari of a remote Himalayan temple, where families have prayed for generations — so your faith stays close, wherever home is.`,
  proof: 'A shared sankalp for all who join · Filmed by our crew at the altar · Prasad couriered home.',
} as const;

export const HOME_SEO: PublicContent = {
  kind: 'home',
  key: 'home',
  canonicalPath: '/',
  title: `Havan & Puja in Your Name at Himalayan Temples | ${BRAND.name}`,
  summary: 'Book a havan online, performed by the pujari of a peaceful Himalayan temple. Watch the video from anywhere and get dry prasad by courier. Made for NRIs.',
  visibility: 'public',
  image: {
    // [WEB-OG-SHARE-1] The homepage's actual hero photo (WEB-HERO-PHOTO-1), so a
    // shared saathum.com link previews with the same picture visitors see first.
    url: '/assets/grand/hero-havan.jpg',
    alt: 'At first light a pujari pours ghee into the havan fire of a mountain temple while our crew films, snow peaks rising behind.',
    revision: 'home-v3',
  },
};
