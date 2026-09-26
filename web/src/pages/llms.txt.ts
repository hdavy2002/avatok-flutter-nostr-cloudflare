import type { APIRoute } from 'astro';
import { rituals } from '../lib/ritualGuides';

export const prerender = true;

const SITE = 'https://saathum.com';

export const GET: APIRoute = () => {
  const featured = rituals.slice(0, 12).map((ritual) =>
    `- [${ritual.title}](${SITE}${ritual.href}): ${ritual.description}`,
  ).join('\n');

  const body = `# Saa Thum

> Saa Thum performs pujas and havans in a devotee's name and gotra. Rituals are performed by Saa Thum priests at a real altar, can be watched live, include a seven-day replay, and may include prasad delivery as described on the booking page.

## Main public resources
- [Home](${SITE}/): What Saa Thum offers and how live participation works.
- [Puja & Havan Guide](${SITE}/rituals): Explanatory guides to the rituals Saa Thum offers.
- [Complete ritual index](${SITE}/llms-rituals.txt): Canonical titles, summaries and URLs generated from the public ritual catalogue.
- [Marketplace](${SITE}/marketplace): Currently public and bookable rituals.
- [How it works](${SITE}/how-it-works): Booking, sankalp, live viewing, replay and prasad.
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
