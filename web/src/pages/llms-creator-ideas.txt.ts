import { creatorIdeas } from '../lib/creatorIdeas';
export const prerender = true;
export function GET() {
  const body = '# avaTOK creator idea guides\n\nIndependent creator business inspiration for India; not job vacancies or income guarantees.\n\n' + creatorIdeas.map(idea => `- [${idea.title}](https://avatok.ai${idea.href}): ${idea.description}`).join('\n') + '\n';
  return new Response(body, { headers: { 'Content-Type':'text/plain; charset=utf-8' } });
}
