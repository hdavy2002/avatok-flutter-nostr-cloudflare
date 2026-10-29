// [HF-SUPPORT-DESK] A very small history router. The desk is one page (pages/support-desk/[...path].astro) and routes in the browser.
// App paths are written WITHOUT the mount prefix ("/desk/t/HF-10240"); this file adds it:
//   support.<domain>/desk/t/HF-1       (the real home: BASE is "")
//   <domain>/support-desk/desk/t/HF-1  (before DNS exists / local preview: BASE is "/support-desk")
import { useCallback, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { SUPPORT_BASE, isSupportHost } from '../../lib/supportHost';

export const BASE: string = typeof location !== 'undefined' && isSupportHost(location.hostname) ? '' : SUPPORT_BASE;

const EVT = 'hfs:navigate';
export const href = (to: string): string => `${BASE}${to === '/' ? '' : to}` || '/';

function snapshot(): string {
  return typeof location === 'undefined' ? '/' : location.pathname + location.search;
}
function subscribe(cb: () => void): () => void {
  window.addEventListener('popstate', cb);
  window.addEventListener(EVT, cb);
  return () => { window.removeEventListener('popstate', cb); window.removeEventListener(EVT, cb); };
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const full = href(to);
  if (full === location.pathname + location.search) { window.dispatchEvent(new Event(EVT)); return; }
  if (opts.replace) history.replaceState(null, '', full); else history.pushState(null, '', full);
  window.dispatchEvent(new Event(EVT));
  window.scrollTo({ top: 0 });
}

/** Change only the query string of the current page (filters), without adding history entries. */
export function setQuery(patch: Record<string, string | null | undefined>, opts: { replace?: boolean } = { replace: true }): void {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(patch)) { if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); }
  const full = u.pathname + u.search;
  if (full === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, '', full); else history.pushState(null, '', full);
  window.dispatchEvent(new Event(EVT));
}

export interface Loc { path: string; params: URLSearchParams }

/** The app-relative path (mount prefix removed, no trailing slash) and the query string. */
export function useLoc(): Loc {
  const snap = useSyncExternalStore(subscribe, snapshot, () => '/');
  const i = snap.indexOf('?');
  let path = i < 0 ? snap : snap.slice(0, i);
  const qs = i < 0 ? '' : snap.slice(i + 1);
  if (BASE && (path === BASE || path.startsWith(`${BASE}/`))) path = path.slice(BASE.length) || '/';
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return { path: path || '/', params: new URLSearchParams(qs) };
}

export function Link({ to, children, onClick, ...rest }: { to: string; children?: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const click = useCallback((e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target === '_blank') return;
    e.preventDefault();
    navigate(to);
  }, [to, onClick, rest.target]);
  return <a {...rest} href={href(to)} onClick={click}>{children}</a>;
}
