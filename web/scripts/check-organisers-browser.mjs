// [SAATHUM-ENTITY-1 2026-09-26] /organisers now redirects home with a server-side 301
// (organisers.astro: prerender = false + Astro.redirect). The browser check runs against a
// STATIC preview of dist/, which cannot execute server-rendered routes, so it can never see
// that redirect (it used to fail with url === /organisers/). The redirect is guarded instead by
// check-organisers.mjs (source guard + "no static file" check) — the same coverage dmca.astro has.
export async function checkOrganisersBrowser() {
  console.log('organisers browser check: skipped (server-rendered 301; covered by check-organisers.mjs).');
}
