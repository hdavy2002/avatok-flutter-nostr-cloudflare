# PHASE Z — Glue everything together + push (RUN LAST, SOLO)

> Carry `MASTER-PROMPT.md`. Runs **alone, after** Phase 0 and the entire A–E parallel wave have finished and written their Graphiti episodes. **You are the ONLY session allowed to commit and push.** Your job is integration, not new features.

## Preconditions (verify before starting)
- Phases 0, A, B, C, D, E each have a Graphiti episode `web-client PHASE-* complete` under `group_id="proj_avaflutterapp"`. Read all six (`search_nodes`/`search_memory_facts` scoped to that group) so you know every file created, every cross-link path, and every "local component to promote" or "contract drift" note they left.
- The working tree has all of A–E's uncommitted files under `web/`. Confirm with `git status`.

## Your goal
One coherent, building, deployable web client: nav wired, routes registered, contract drift resolved, full build green, then **commit + push** and deploy to Cloudflare Pages.

## Files you own / may edit (the shared + integration surface)
```
web/src/components/Nav.astro          # add the real nav links now that routes exist
web/src/layouts/Base.astro            # finalize meta/OG defaults if needed
web/astro.config.mjs                  # confirm hybrid/SSR per-route settings
web/src/components/                    # PROMOTE any local components A–E flagged for promotion
web/src/lib/                           # reconcile apiClient/types if a phase needed a field added
web/package.json                       # finalize deps (e.g. hls.js) + scripts
web/README.md , Specs/web-client/*     # update docs/status
+ any small integration shim needed to make the build pass
```
You may edit across `web/` to integrate — but **still do not touch `app/` or `worker/`**.

## Steps
1. **Inventory:** `git status` + read the six Graphiti episodes. Build a checklist of: routes created, cross-links emitted, components to promote, any field a phase added to `apiClient`/`types`, any TODO/stub left.
2. **Wire the nav** (`Nav.astro`): add links — Explore (`/explore`), Dashboard (`/dashboard`), Sign in (`/sign-in`), and the logo → `/`. Keep it `zine`-styled. Mobile = hamburger sheet.
3. **Resolve contract drift:** if two phases defined the same type differently, or a phase stubbed a kit component locally, reconcile into `web/src/lib/types.ts` / `web/src/components/` and update the importers. Promote flagged local components into the shared kit and repoint imports.
4. **Cross-link sanity:** verify every cross-phase link resolves to a real route: `/l/<id>`→`/book/<id>`→`/watch|consult|agent/...`→`/dashboard`. Click through the whole funnel.
5. **Full build:** `cd web && npm run build`. Fix every error/warning. Run `npm run preview` (or `wrangler pages dev`) and smoke-test each surface: landing, explore, a listing, a creator page, an event page, the booking flow (Stripe test), a live watch page (gate), a consult room (gate), an agent call (start/stop). Confirm static pages ship populated HTML (view-source) and islands hydrate lazily.
6. **Performance pass (the objective):** check bundle sizes — `hls.js` lazy, no LiveKit, islands `client:visible`/`client:idle` where possible, fonts preloaded, images via Cloudflare transform. Lighthouse the landing + a listing page; fix obvious regressions.
7. **Deploy config:** confirm the Cloudflare Pages project (per PROPOSAL §12 — extend `avatok-web` or a new `avatok-app` project), env vars (`PUBLIC_API_BASE`, `PUBLIC_CLERK_PUBLISHABLE_KEY`), and that the apex/`www` routing doesn't clash with the existing marketing site. Set up the Pages build command (`npm run build`) + output dir.
8. **Commit + push (only now):**
   - Stage `web/` and the `Specs/web-client/` doc updates. **Do not** stage anything under `app/` or `worker/` (there should be nothing there anyway — verify).
   - One clear commit, e.g. `feat(web): public web client — marketplace, guest checkout, live/consult/agent viewers (Astro on CF Pages)`.
   - Push to the repo's working branch.
   - Per the project's standing rule, after the push write a **detailed Graphiti episode** logging the push (what shipped, commit hash, deploy target).
9. **Deploy:** trigger the Cloudflare Pages deploy (via the dashboard/CI or `wrangler pages deploy`). Verify the live preview URL renders and a public listing page previews correctly when shared.

## Acceptance checklist
- [ ] `cd web && npm run build` is green; preview smoke-tests pass for all surfaces.
- [ ] Nav wired; every cross-phase link resolves; full funnel clickable.
- [ ] No duplicate/divergent types or components; promotions done.
- [ ] No LiveKit in the web bundle; `hls.js` lazy; islands lazy-hydrated; fonts/images optimized.
- [ ] Nothing under `app/` or `worker/` changed.
- [ ] Committed **once** and pushed; post-push Graphiti episode written; Cloudflare Pages deploy verified.

## Graphiti (after the push)
`add_memory(group_id="proj_avaflutterapp", name="web-client PHASE-Z complete — glued, pushed, deployed", episode_body="...commit hash, files, deploy target, smoke-test results, any follow-ups...")`. This is the **only** phase that commits.
