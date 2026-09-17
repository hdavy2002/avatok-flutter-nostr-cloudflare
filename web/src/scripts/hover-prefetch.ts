// Warm the next public page after deliberate pointer/keyboard intent.
// This uses the browser HTTP cache; it does not render or hydrate the page.
const warmed = new Set<string>();
const pending = new Map<string, number>();
const MAX_IMAGE_WARM = 3;

function eligible(anchor: HTMLAnchorElement): URL | null {
  if (anchor.target === '_blank' || anchor.hasAttribute('download')) return null;
  if (anchor.dataset.prefetch === 'off' || anchor.rel.split(/\s+/).includes('nofollow')) return null;
  if (matchMedia('(prefers-reduced-data: reduce)').matches) return null;
  let url: URL;
  try { url = new URL(anchor.href, location.href); } catch { return null; }
  if (url.origin !== location.origin || url.protocol !== location.protocol) return null;
  if (url.pathname === location.pathname || url.pathname.startsWith('/api/')) return null;
  // Private views have no useful public cache and may contain account data.
  if (/^\/(?:dashboard|admin|j|talk)(?:\/|$)/.test(url.pathname)) return null;
  return url;
}

function warmImages(html: string, pageUrl: URL): void {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const sources = [...doc.querySelectorAll<HTMLImageElement>('img[src], img[srcset]')]
    .filter((image) => !image.loading || image.loading !== 'lazy')
    .map((image) => image.currentSrc || image.src || image.srcset.split(',')[0]?.trim().split(/\s+/)[0])
    .filter(Boolean)
    .slice(0, MAX_IMAGE_WARM);
  for (const source of sources) {
    try {
      const imageUrl = new URL(source!, pageUrl);
      if (imageUrl.origin !== location.origin || !/\/cdn-cgi\/image\//.test(imageUrl.pathname)) continue;
      const image = new Image();
      image.decoding = 'async';
      image.src = imageUrl.href;
    } catch { /* malformed or external media is ignored */ }
  }
}

function prefetch(url: URL): void {
  const key = url.href;
  if (warmed.has(key) || pending.has(key)) return;
  pending.set(key, window.setTimeout(() => {
    pending.delete(key);
    warmed.add(key);
    // A prefetch link lets the browser manage priority and reuse its HTTP cache.
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.as = 'document';
    link.href = key;
    document.head.appendChild(link);
    // Fetching the document also lets us warm its first visible public artwork.
    void fetch(key, { credentials: 'same-origin', cache: 'force-cache', headers: { Accept: 'text/html' } })
      .then((response) => response.ok ? response.text() : '')
      .then((html) => { if (html) warmImages(html, url); })
      .catch(() => undefined);
  }, 80));
}

function onIntent(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest<HTMLAnchorElement>('a[href]');
  const url = anchor && eligible(anchor);
  if (url) prefetch(url);
}

document.addEventListener('pointerover', onIntent, { passive: true });
document.addEventListener('focusin', onIntent, { passive: true });
