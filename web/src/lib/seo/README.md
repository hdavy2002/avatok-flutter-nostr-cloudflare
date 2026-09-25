# Public page discovery contract

Every public page must reach `Base.astro` with a `PublicContent` object. `Content.astro`
and `Help.astro` do this automatically; direct layouts must pass `content={...}`.

That one record owns the canonical path, unique title/summary, robots policy,
Open Graph and Twitter tags, the versioned 1200×630 `/og/...png` card, and JSON-LD.
Unknown routes fail closed to `noindex`, so a new page cannot silently enter search
with homepage metadata. Draft, private, unlisted, archived, cancelled and ended
records are also excluded.

Dynamic listings and creators must use `listingContent()` / `creatorContent()`.
Their `discovery` field comes from the Worker's shared eligibility predicate; the
same predicate drives detail metadata, sitemap feeds and sitemap counts.

When adding a new public collection or dynamic content kind:

1. create its `PublicContent` from the same data rendered on the page;
2. add a trusted lookup to `resolveOgRecord()` (request text is never rendered);
3. include its canonical URLs in a static or paginated sitemap source;
4. keep the visible claims and schema facts identical;
5. let `scripts/check-seo.mjs` run in the manually dispatched web workflow.

`llms.txt` is a generated navigation aid, not a ranking mechanism. Search and AI
citations depend on accurate, useful public content and are never guaranteed.
