import type { APIRoute } from 'astro';
import { BRAND, brandUrl } from '../lib/brand';
import { fetchLiveHosts, fetchMerchSitemap } from '../lib/merchPublic';
// [HF-MERCH-FAN-WEB-1 2026-10-23] Now rendered on request so it can list the live influencers and their merch in plain sentences.
// The fixed part is unchanged; the lists are capped and silently left out when the API is unavailable.
export const prerender = false;
const MAX_HOSTS = 100;
const MAX_PRODUCTS = 200;
const oneLine = (s: string | null | undefined, max = 140): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export const GET: APIRoute = async () => {
  const [hosts, merch] = await Promise.all([fetchLiveHosts(4), fetchMerchSitemap()]);
  const nameOf = new Map(hosts.map((h) => [h.slug, h.displayName]));
  const hostLines = hosts.slice(0, MAX_HOSTS).map((h) => {
    const t = oneLine(h.tagline);
    return `- [${oneLine(h.displayName, 60)}](${brandUrl(`/h/${h.slug}`)}): ${oneLine(h.displayName, 60)} is an influencer you can talk to on a private, masked phone call.${t ? ` ${t}${/[.!?]$/.test(t) ? '' : '.'}` : ''}`;
  });
  const productLines = (merch?.products ?? []).slice(0, MAX_PRODUCTS).map((p) => {
    const by = nameOf.get(p.hostSlug) ?? p.hostSlug;
    return `- [${oneLine(p.title, 80)}](${brandUrl(`/h/${p.hostSlug}/merch/${p.slug}`)}): A T-shirt by ${oneLine(by, 60)}, printed to order in India, with free delivery across India.`;
  });
  const body = `# ${BRAND.name} (${BRAND.domain})

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
${hostLines.length ? `\n## Influencers\nEach influencer has a public page with their languages, topics, per-minute price and reviews.\n${hostLines.join('\n')}\n` : ''}${productLines.length ? `\n## Influencer merch\nInfluencers sell their own T-shirts. Each one is printed to order, delivered free across India, and cannot be returned; a wrong or damaged item can be reported within 48 hours of delivery. Prices are in Indian rupees and include everything.\n${productLines.join('\n')}\n` : ''}
## Editorial boundaries
A paid influencer call does not promise friendship, emotional care, therapy or professional support. Refer to current product pages for feature availability.

Language: English (India). Sitemap: ${brandUrl('/sitemap.xml')}.
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300, s-maxage=900', 'X-Content-Type-Options': 'nosniff' } });
};
