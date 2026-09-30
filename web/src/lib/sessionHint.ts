// [WEB-PERF-3 2026-09-30] "Is someone probably signed in?" — answered from the
// Clerk session cookie, WITHOUT loading Clerk (~300 KB of clerk-js + the React
// SDK). Islands on public pages use this to decide whether to load Clerk at all:
// a signed-out visitor never needs it, a signed-in one gets it in the background.
// Same test as the header's inline script (components/SiteHeader.astro).
// It is only a hint: a true here still means "ask Clerk", never "trust this".
export function hasClerkSessionHint(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const m = document.cookie.match(/(?:^|;\s*)__client_uat(?:_[A-Za-z0-9]+)?=([^;]*)/);
    return Boolean(m && m[1] && m[1] !== '0');
  } catch {
    return false;
  }
}
