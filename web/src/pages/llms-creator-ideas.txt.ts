import { creatorIdeas } from '../lib/creatorIdeas';
export const prerender = true;
export function GET() {
  const body = '# Saathum creator idea guides\n\nIndependent creator business inspiration from Ava Global International, Inc., a Delaware company; not job vacancies or income guarantees.\n\n' + creatorIdeas.map(idea => `- [${idea.title}](https://saathum.com${idea.href}): ${idea.description}`).join('\n') + '\n';
  return new Response(body, { headers: { 'Content-Type':'text/plain; charset=utf-8' } });
}
