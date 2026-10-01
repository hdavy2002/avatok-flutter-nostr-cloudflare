import type { APIRoute } from 'astro';
import { rituals } from '../lib/ritualGuides';
import { BRAND } from '../lib/brand';

export const prerender = true;

export const GET: APIRoute = () => {
  const rows = rituals.map((ritual) =>
    `- [${ritual.title}](${BRAND.webOrigin}${ritual.href}): ${ritual.description}`,
  ).join('\n');
  const body = `# ${BRAND.name} Puja & Havan Guide: every ritual we arrange\n\n${rows}\n`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
