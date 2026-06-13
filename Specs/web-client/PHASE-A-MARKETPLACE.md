# PHASE A — Marketplace + public SSR pages (PARALLEL)

> Carry `MASTER-PROMPT.md`. Runs **simultaneously** with B, C, D, E **after** Phase 0. You build the SEO/share funnel: the static, edge-cached, link-preview-friendly surfaces + the marketplace browse island. **No commit.**

## Your goal
A fan clicks a YouTube-description link → lands on a fast, server-rendered public page (creator / listing / event) that previews beautifully when shared, with a clear call-to-action that links into the booking flow (Phase B owns `/book/<id>`). Plus a browse/search marketplace.

## Files you own (create/edit ONLY these)
```
web/src/pages/index.astro            # the REAL landing (overwrite Phase 0 placeholder)
web/src/pages/explore.astro          # marketplace browse + filters
web/src/pages/c/[handle].astro       # public creator channel
web/src/pages/l/[id].astro           # public listing page
web/src/pages/e/[event].astro        # public scheduled-event page
web/src/islands/marketplace/         # ExploreGrid.tsx, Filters.tsx, SearchBox.tsx, LiveNowRail.tsx
web/src/lib/og.ts                    # helper to build OpenGraph/Twitter meta (LOCAL to phase A)
```
Do **not** touch the shared kit, layout, nav, config, or any other phase's pages.

## Gating: NONE here
The entire marketplace and all public pages you build are **ungated** — no sign-in, no email prompt, ever. Anyone with a shared link browses freely. The email→OTP guest gate happens later, only at checkout (Phase B) or at "Talk now" on an agent (Phase E). Do not add any auth prompt to these pages. (MASTER-PROMPT §4b.)

## Endpoints you use (all PUBLIC, no auth — MASTER-PROMPT §4)
- `GET /api/explore` , `/api/explore/live-now` , `/api/explore/search` , `/api/explore/categories`
- `GET /api/listings/:id` , `GET /api/creators/:id`

## Steps
1. **Pages are SSR/prerendered Astro**, not islands. Fetch the public read **server-side** in the Astro frontmatter (using `apiClient`) so the HTML ships fully populated → instant first paint + correct OG tags. Set per-page cache headers (`Cache-Control: public, max-age=60`) to ride the edge cache, mirroring the Worker's own cache policy.
2. **`l/[id].astro`** — call `getListing(id)`. Render poster card (kit `ListingTile`/`Card`), title, creator, price, description, rating, reviews. Build OG/Twitter meta from the listing (title, first photo, description) via `lib/og.ts`. Primary CTA button:
   - live event → links to `/watch/<id>` (Phase C) if `status==='live'`, else "Book" → `/book/<id>` (Phase B).
   - consult listing → "Book" → `/book/<id>`.
   - agent listing → "Talk now" → `/agent/<id>` (Phase E) or "Book" → `/book/<id>`.
   (Just render the `<a href>` — do not build those targets.)
3. **`c/[handle].astro`** — call `getCreator(handle)`. Render channel header (avatar, name, follower/rating stats), then a grid of that creator's listings (kit `ListingTile`), each linking to `/l/<id>`. OG meta = creator name + avatar.
4. **`e/[event].astro`** — the shareable scheduled-event page. Use `getListing` for the event listing; show date/time, countdown, "Add to calendar", CTA → `/book/<id>`.
5. **`explore.astro`** — static shell + the `ExploreGrid` island (`client:visible`). Island calls `/api/explore` with filters (`Filters.tsx`) and `/api/explore/search` (`SearchBox.tsx`), paginates via the `cursor` field, and renders a `LiveNowRail` from `/api/explore/live-now` at the top. Cards link to `/l/<id>`.
6. **`index.astro`** — landing: hero in `zine` style, the live-now rail, a few category tiles linking into `/explore?category=...`, and the "creators: get the app / fans: browse here" split. Keep it static; one small island for the live rail is fine.
7. **Responsive:** Tailwind breakpoints — single column on phone, 2–3 col grid on tablet, 4-col on desktop. Test all three widths.
8. **Performance:** images via the Cloudflare transform URL (kit `Avatar`/image helper); lazy-load below-the-fold; islands `client:visible`.

## Acceptance checklist
- [ ] `/l/<realId>` server-renders with correct content and valid OG/Twitter tags (check `view-source` — content present without JS).
- [ ] `/c/<handle>` and `/e/<event>` render and link correctly.
- [ ] `/explore` browse + filter + search + live-now rail work against the real API; pagination via `cursor`.
- [ ] All CTAs link to the correct agreed paths (`/book`, `/watch`, `/agent`) — even though those pages belong to other phases.
- [ ] Responsive at phone/tablet/desktop; `zine` look via kit + tokens; no hardcoded hex.
- [ ] `cd web && npm run build` compiles your additions. Nothing outside your owned files changed. No commit.

## Graphiti (then STOP)
`add_memory(group_id="proj_avaflutterapp", name="web-client PHASE-A complete — marketplace + public SSR pages", ...)` — files created, endpoints used, OG approach, any local component Phase Z should promote, the exact cross-link paths you emitted. **Do not commit.**
