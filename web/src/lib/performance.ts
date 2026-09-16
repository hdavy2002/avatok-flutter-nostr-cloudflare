// Readiness supplements Core Web Vitals: LCP need not be the headline, and
// INP is emitted only after a qualifying interaction on supported browsers.
import { onCLS, onINP, onLCP, type Metric } from 'web-vitals';
import { capture, uiInteraction } from './analytics';
let started = false;

function context(): Record<string, unknown> {
  const path = location.pathname;
  // Do not put usernames, booking IDs, join tokens or query values in metrics.
  const sections = new Set(['dashboard', 'marketplace', 'help', 'blog', 'ideas', 'sign-in', 'sign-up', 'pricing', 'l', 'e', 'j', 'talk', 'admin']);
  const first = path.split('/').filter(Boolean)[0];
  const route = !first ? '/' : sections.has(first) ? '/' + first + (path.split('/').filter(Boolean).length > 1 ? '/[detail]' : '') : '/[page]';
  const connection = (navigator as Navigator & { connection?: { effectiveType?: string; saveData?: boolean } }).connection;
  return {
    route_template: route,
    release: import.meta.env.PUBLIC_RELEASE_SHA || 'dev',
    device_class: innerWidth < 768 ? 'phone' : innerWidth < 1024 ? 'tablet' : 'desktop',
    network_class: connection?.effectiveType ?? 'unknown',
    save_data: connection?.saveData ?? false,
  };
}

/** Caller owns lifecycle/deduplication; startedAt uses performance.now() clock.
 * A zero start records navigation-to-ready. Never pass personal payloads. */
export function markReady(name: string, props: Record<string, unknown> = {}, startedAt = 0): void {
  if (typeof window === 'undefined') return;
  const ms = Math.max(0, performance.now() - startedAt);
  performance.mark('avatok:' + name);
  uiInteraction(name, ms, { ...context(), ...props, readiness: true });
}

function report(metric: Metric): void {
  capture('web_performance', {
    ...context(), metric: metric.name, value: metric.value,
    rating: metric.rating, metric_id: metric.id,
    navigation_type: metric.navigationType,
  });
}

export function initPerformance(): void {
  if (typeof window === 'undefined' || started) return;
  started = true;
  // Standard build uses buffered observers and bfcache lifecycle handling.
  // Existing Cloudflare/PostHog RUM remains intact; this distinct event also
  // carries our release/template context. No element text/attribution is sent.
  onLCP(report);
  onCLS(report);
  onINP(report);
  const hero = document.getElementById('rail-title');
  if (hero) requestAnimationFrame(() => {
    const style = getComputedStyle(hero);
    if (style.visibility !== 'hidden' && Number(style.opacity) > 0) {
      // Upper bound at module execution, not a claim of exact first-paint time.
      markReady('hero_visible', { measurement: 'first_visible_frame_observed' });
    }
  });
}
