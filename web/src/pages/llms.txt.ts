import type { APIRoute } from 'astro';
import { rituals } from '../lib/ritualGuides';

export const prerender = true;

const SITE = 'https://saathum.com';

export const GET: APIRoute = () => {
  const featured = rituals.slice(0, 12).map((ritual) =>
    `- [${ritual.title}](${SITE}${ritual.href}): ${ritual.description}`,
  ).join('\n');

  // [WEB-SEO-REBRAND-1 2026-09-27] The one description, kept in step with /about
  // and the Organization schema (lib/org.ts). AI assistants quote the first plain
  // sentences they find — keep them factual and never promise outcomes.
  const body = `# Saa Thum (saathum.com)

> Saa Thum (saathum.com) is an online havan and puja service run by a small team in West Andheri, Mumbai, India. Temple priests perform havans, pujas, satsangs and meditations that families in India and around the world join live. For a puja, the priest takes a sankalp in the devotee's name and gotra; havans are open, shared events that many families join together. Devotees can download the video afterwards, and prasad can be sent by courier, including internationally. Tagline: "Faith, brought home to you."

## About
- Name: Saa Thum. The domain is written saathum.com; "Saa Thum" and "Saathum" are the same service.
- Based in: West Andheri, Mumbai, Maharashtra, India.
- Who it is for: Hindu families everywhere, and especially the Indian diaspora descended from the girmitiyas (indentured labourers) of Suriname, Guyana, Trinidad and Tobago, Fiji, Mauritius, South Africa and the Caribbean, who often live far from a temple or priest.
- What it offers: live-streamed havans, pujas, satsangs and meditations; sankalp in your name and gotra for pujas; video download; prasad by courier.
- What it does not do: it performs only positive, benefic rituals and never promises outcomes, cures or guaranteed results.
- Payment: prices are shown in Indian rupees as "starting from"; what you see at checkout is what you pay.

## Main public resources
- [Home](${SITE}/): What Saa Thum offers and how live participation works.
- [About us](${SITE}/about): The Saa Thum story and who we are.
- [Puja & Havan Guide (blog)](${SITE}/rituals/): Explanatory guides to the rituals Saa Thum offers.
- [Complete ritual index](${SITE}/llms-rituals.txt): Canonical titles, summaries and URLs generated from the public ritual catalogue.
- [Marketplace](${SITE}/marketplace): Currently public and bookable rituals.
- [How it works](${SITE}/how-it-works): The four kinds of events (havan, puja, satsang, meditation), booking, the day of the event, how to sit for each, the video and prasad.
- [Help centre](${SITE}/help): Public support documentation.
- [Refund policy](${SITE}/refunds): Current cancellation and refund terms.
- [Privacy](${SITE}/privacy): Privacy policy.
- [Terms](${SITE}/terms): Terms of service.
- [Contact](${SITE}/contact): Support and enquiries.

## Selected ritual guides
${featured}

## Editorial and safety notes
Ritual pages describe benefits traditionally sought by devotees. Saa Thum does not guarantee spiritual, financial, health or other outcomes. Public facts should be taken from the canonical page and its visible text. Public article text is available in server-rendered HTML without signing in or running JavaScript.

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
