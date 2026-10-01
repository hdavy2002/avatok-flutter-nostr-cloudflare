import type { APIRoute } from 'astro';
import { rituals } from '../lib/ritualGuides';
import { BRAND } from '../lib/brand';
import { ORG } from '../lib/org';

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

> ${ORG.description} Tagline: "${BRAND.slogan}"

## About
- Name: ${BRAND.name}, at ${BRAND.domain}. ${BRAND.nameMeaningShort}
- Home base: Dehradun, Uttarakhand, India. Our crew travels to temples throughout Uttarakhand and Himachal Pradesh.
- Temples: positive temples only (Shiva and Parvati, Vishnu, Ram and Sita, Krishna, the Himalayan Devis). Temples associated with animal sacrifice, fear, tantric, cult or black-magic practices are excluded, and no Kali, Bhairav or Shani rituals are offered.
- Audience: Hindu families in any country, NRIs, and in particular the descendants of the girmitiyas (indentured labourers) now living in Suriname, Guyana, Trinidad and Tobago, Fiji, Mauritius, South Africa and the wider Caribbean, who are often far from a temple or a priest.
- Services: havans and pujas carried out at Himalayan temples by each temple's own pujari and filmed by the ${BRAND.name} crew (live streamed when the network allows); a collective sankalp for open havans and a personal sankalp (name, gotra, wish) for Sankalp Puja or Havan; a downloadable video; dry prasad by courier.
- Limits: only positive, benefic rituals are performed, and no outcome, cure or result is ever promised.
- Pricing: shown in Indian rupees as "starting from"; the checkout total is the amount you pay.

## Main public resources
- [Home](${SITE}/): The service in brief and how families take part from home.
- [About us](${SITE}/about): How ${BRAND.name} began, and the people behind it.
- [Puja & Havan Guide (blog)](${SITE}/rituals/): One article per ritual, covering meaning, deity, timing and taking part.
- [Complete ritual index](${SITE}/llms-rituals.txt): Canonical titles, summaries and URLs generated from the public ritual catalogue.
- [Marketplace](${SITE}/marketplace): Rituals open for booking right now.
- [How it works](${SITE}/how-it-works): The four event types (havan, puja, satsang, meditation), booking steps, what happens on the day, how to sit for each, the video and prasad.
- [Our temples](${SITE}/temples): Partner temples in Uttarakhand and Himachal, live streaming from the altar, the full recording when the network fails, same-day dry prasad, and why charawa stays at the temple.
- [Help centre](${SITE}/help): Answers on booking, sankalp, video, prasad and refunds.
- [Refund policy](${SITE}/refunds): The cancellation and refund terms in force.
- [Privacy](${SITE}/privacy): Privacy policy.
- [Terms](${SITE}/terms): Terms of service.
- [Contact](${SITE}/contact): Reach the support team.

## Selected ritual guides
${featured}

## Editorial and safety notes
Benefits on ritual pages are those devotees traditionally seek; ${BRAND.name} guarantees no spiritual, financial, health or other outcome. Take facts from each canonical page's visible text. All public articles are server-rendered HTML, readable without signing in or running JavaScript.

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
