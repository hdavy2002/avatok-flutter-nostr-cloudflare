import type { APIRoute } from 'astro';
import { BRAND, brandUrl } from '../lib/brand';
import { blogArticles } from '../lib/fraandsBlog';
import { blogHref } from '../lib/fraandsBlogSeo';
export const prerender = true;
export const GET: APIRoute = () => new Response(`# ${BRAND.name} (${BRAND.domain})

> ${BRAND.nameMeaningLong}

## Public resources
- [Home](${brandUrl('/')}): Product preview for adults 18+.
- [How it works](${brandUrl('/how-it-works')}): Planned host conversations, private phone numbers and clear per-minute prices.
- [Blog](${brandUrl('/blog/')}): Friendship, conversation, listening and shared interests.
- [Safety](${brandUrl('/safety')}): Boundaries and safety guidance.
- [Rules of engagement](${brandUrl('/rules-of-engagement')}): Respectful conversation expectations.
- [Emergency](${brandUrl('/emergency')}): Guidance when immediate help is needed.
- [Privacy](${brandUrl('/privacy')}): Privacy policy.
- [Terms](${brandUrl('/terms')}): Terms of service.
- [Contact](${brandUrl('/contact')}): Contact the team.

## All blog articles
${blogArticles.map(article => `- [${article.title}](${brandUrl(blogHref(article))}): ${article.summary}`).join('\n')}

## Editorial boundaries
A paid host conversation does not promise friendship, emotional care, therapy or professional support. These articles offer everyday conversation ideas. Refer to current product pages for feature availability. Removed articles are retired, not equivalent to new blog articles.

Language: English (India). Sitemap: ${brandUrl('/sitemap.xml')}.
`, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
