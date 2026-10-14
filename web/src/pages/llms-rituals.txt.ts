import type { APIRoute } from 'astro';
export const prerender = false;
export const GET: APIRoute = () => new Response('This index has been removed. Current articles: /blog/\n', { status: 410, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'public, max-age=3600' } });
