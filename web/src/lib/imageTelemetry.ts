import { capture } from './analytics';
let installed = false;
/** Sample real browser timing only; no URLs or inferred CDN HIT claims. */
export function initImageTelemetry() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  if (Math.random() >= 0.05 || !('PerformanceObserver' in window)) return;
  let remaining = 20;
  const observer = new PerformanceObserver(list => {
    for (const item of list.getEntries()) {
      if (remaining <= 0) { observer.disconnect(); break; }
      const entry = item as PerformanceResourceTiming;
      let url: URL;
      try { url = new URL(entry.name); } catch { continue; }
      if (url.origin !== location.origin || url.search || !url.pathname.startsWith('/cdn-cgi/image/')) continue;
      const width = /(?:,|\/)width=(\d+)(?:,|\/)/.exec(url.pathname)?.[1];
      --remaining;
      capture('public_image_timing', {
        duration_ms: Math.round(entry.duration), transfer_bytes: entry.transferSize,
        encoded_bytes: entry.encodedBodySize, decoded_bytes: entry.decodedBodySize,
        transform_width: width ? Number(width) : undefined,
        // Zero can mean browser reuse or unavailable timing; do not label it a cache HIT.
        transfer_size_available: entry.transferSize > 0, sample_rate: 0.05,
      });
    }
  });
  try { observer.observe({type: 'resource', buffered: true}); } catch { observer.disconnect(); }
}
