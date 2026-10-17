import type { APIRoute } from 'astro';
import { BRAND, brandUrl } from '../lib/brand';
export const prerender = true;
export const GET: APIRoute = () => new Response(`# ${BRAND.name} (${BRAND.domain})

> ${BRAND.nameMeaningLong}

## Public resources
- [Home](${brandUrl('/')}): Product preview for adults 18+.
- [How it works](${brandUrl('/how-it-works')}): Planned private phone calls with influencers, masked phone numbers and clear per-minute prices.
- [Help centre](${brandUrl('/help')}): Answers about calls, privacy, safety and the wallet.
- [Safety](${brandUrl('/safety')}): Boundaries and safety guidance.
- [Rules of engagement](${brandUrl('/rules-of-engagement')}): Respectful conversation expectations.
- [Emergency](${brandUrl('/emergency')}): Guidance when immediate help is needed.
- [Privacy](${brandUrl('/privacy')}): Privacy policy.
- [Terms](${brandUrl('/terms')}): Terms of service.
- [Contact](${brandUrl('/contact')}): Contact the team.

## Editorial boundaries
A paid influencer call does not promise friendship, emotional care, therapy or professional support. Refer to current product pages for feature availability.

Language: English (India). Sitemap: ${brandUrl('/sitemap.xml')}.
`, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
