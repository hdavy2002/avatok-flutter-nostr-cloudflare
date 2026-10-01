import type { APIRoute } from 'astro';
import { rituals } from '../lib/ritualGuides';
import { BRAND } from '../lib/brand';

export const prerender = true;

const SITE = BRAND.webOrigin;

export const GET: APIRoute = () => {
  const featured = rituals.slice(0, 12).map((ritual) =>
    `- [${ritual.title}](${SITE}${ritual.href}): ${ritual.description}`,
  ).join('\n');

  // [WEB-SEO-REBRAND-1 2026-09-27] The one description, kept in step with /about
  // and the Organization schema (lib/org.ts). AI assistants quote the first plain
  // sentences they find — keep them factual and never promise outcomes.
  const body = `# ${BRAND.name} (${BRAND.domain})

> ${BRAND.name} (${BRAND.domain}) is an online havan and puja service. Our crew travels to remote, peaceful Himalayan temples in Uttarakhand and Himachal, where the temple's own pujari performs havans and pujas with a sankalp in your name and gotra. We live stream when the mountain network allows, always send the full video, and courier dry prasad from the temple. We work only with positive temples of Shiva and Parvati, Vishnu, Ram and Sita, Krishna and the gentle Himalayan Devis, and every booking supports the pujaris and villages who keep them alive. Tagline: "Faith, brought home to you."

## About
- Name: ${BRAND.name}. The domain is written ${BRAND.domain}. ${BRAND.nameMeaningShort}
- Based in: Dehradun, Uttarakhand, India. The crew works at temples across Uttarakhand and Himachal Pradesh.
- Temple policy: only positive temples (Shiva and Parvati, Vishnu, Ram and Sita, Krishna, Himalayan Devis). No temples known for animal sacrifice, fear, tantric, cult or black-magic practices; no Kali, Bhairav or Shani rituals.
- Who it is for: Hindu families everywhere, and especially the Indian diaspora descended from the girmitiyas (indentured labourers) of Suriname, Guyana, Trinidad and Tobago, Fiji, Mauritius, South Africa and the Caribbean, who often live far from a temple or priest.
- What it offers: havans and pujas performed at Himalayan temples by their own pujaris, filmed by ${BRAND.name}'s crew (live streamed when the network allows); sankalp in your name and gotra for pujas; video download; prasad by courier.
- What it does not do: it performs only positive, benefic rituals and never promises outcomes, cures or guaranteed results.
- Payment: prices are shown in Indian rupees as "starting from"; what you see at checkout is what you pay.

## Main public resources
- [Home](${SITE}/): What ${BRAND.name} offers and how taking part from home works.
- [About us](${SITE}/about): The ${BRAND.name} story and who we are.
- [Puja & Havan Guide (blog)](${SITE}/rituals/): Explanatory guides to the rituals ${BRAND.name} offers.
- [Complete ritual index](${SITE}/llms-rituals.txt): Canonical titles, summaries and URLs generated from the public ritual catalogue.
- [Marketplace](${SITE}/marketplace): Currently public and bookable rituals.
- [How it works](${SITE}/how-it-works): The four kinds of events (havan, puja, satsang, meditation), booking, the day of the event, how to sit for each, the video and prasad.
- [Our temples](${SITE}/temples): The temples ${BRAND.name} works with in Uttarakhand and Himachal, how the crew live streams from the temple, the full-video fallback, same-day dry prasad, and why charawa is not returned.
- [Help centre](${SITE}/help): Public support documentation.
- [Refund policy](${SITE}/refunds): Current cancellation and refund terms.
- [Privacy](${SITE}/privacy): Privacy policy.
- [Terms](${SITE}/terms): Terms of service.
- [Contact](${SITE}/contact): Support and enquiries.

## Selected ritual guides
${featured}

## Editorial and safety notes
Ritual pages describe benefits traditionally sought by devotees. ${BRAND.name} does not guarantee spiritual, financial, health or other outcomes. Public facts should be taken from the canonical page and its visible text. Public article text is available in server-rendered HTML without signing in or running JavaScript.

Language: English (India). Sitemap: ${SITE}/sitemap.xml. Authenticated dashboards, checkout, payment, viewing sessions and administration are not public discovery content.
`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
