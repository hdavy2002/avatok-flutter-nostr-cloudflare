import { BRAND } from './brand';
/** Removed articles never redirect to unrelated replacement content. */
export function removedBlogPage(): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Page removed · ${BRAND.name}</title></head><body><main><h1>This page has been removed</h1><p>Explore our articles about conversation, friendship and shared interests.</p><a href="/blog/">Visit the blog</a></main></body></html>`, {
    status: 410, headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex', 'cache-control': 'public, max-age=3600' },
  });
}
