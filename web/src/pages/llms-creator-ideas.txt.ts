export const prerender = true;
export function GET() {
  return new Response(null, {
    status: 301,
    headers: { Location: '/llms.txt', 'X-Robots-Tag': 'noindex' },
  });
}
