import type { APIRoute } from 'astro';
import { rituals } from '../lib/ritualGuides';

export const prerender = true;

export const GET: APIRoute = () => {
  const rows = rituals.map((ritual) =>
    `- [${ritual.title}](https://saathum.com${ritual.href}): ${ritual.description}`,
  ).join('\n');
  const body = `# Saathum Puja & Havan Guide\n\n${rows}\n`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
