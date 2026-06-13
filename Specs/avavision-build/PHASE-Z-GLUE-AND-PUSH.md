# PHASE Z — Glue everything + push (RUN LAST, SOLO, the ONLY session that commits)

> Carry `MASTER-PROMPT.md`. Run **alone**, after Phases 0–6 have each posted a Graphiti episode and
> written their `Specs/avavision-build/glue/PHASE-*-GLUE.md`. You wire all shared files, make the whole
> thing build, then **commit once and push**. You are the only session permitted to use git.

## Preconditions (verify before doing anything)
- Each of Phases 0,1,2,3,4,5,6 has a Graphiti episode `AvaVision PHASE-* complete` / `AvaAdmin PHASE-6
  complete` under `group_id="proj_avaflutterapp"`. Read all seven (`search_nodes`/`search_memory_facts`
  scoped to that group). If a phase is missing, do NOT proceed for that phase's shared edits — note it.
- Each glue note exists in `Specs/avavision-build/glue/`. Read all of them.
- `git status` shows the uncommitted work from all phases in the tree. Confirm nothing is committed yet.
- **Capture a rollback point:** record the current HEAD (`git rev-parse HEAD`) and confirm the working
  tree's pre-existing tracked changes are understood, so a bad glue can be reset with
  `git reset --hard <recorded-HEAD>` without losing un-owned work. Take note of any concurrent session
  warning (per the repo-archive memory: beware sessions sharing git).

## Your goal
One coherent, building, deployable AvaVision across worker + Android app + web, with the shared files
wired, then a single commit + push, D1 migration applied, and a Graphiti push log.

## Files you own / may edit (the shared + integration surface — from the glue notes)
- `worker/src/index.ts` — add the `avavision` import + the full dispatch block (from PHASE-1-GLUE).
- `worker/src/routes/config.ts` — add `avavisionEnabled: boolean;` + default `true` (PHASE-1-GLUE).
- `worker/wrangler.toml` — add the `avavision.sql` migration tag + `AVAVISION_SNAPSHOT_MODEL` var
  (PHASE-1-GLUE). **No new Durable Object** — confirm none was introduced.
- `app/lib/core/app_registry.dart`, `app/lib/shell/ava_sidebar.dart` (sidebar is under `shell/`, not
  `core/`), the Create-Listing flow file — add the AvaVision entries (PHASE-2-GLUE).
- `app/pubspec.yaml`, `app/android/app/build.gradle` — add the deps/assets (PHASE-3-GLUE).
- `web/src/components/Nav.astro` — add the `Vision` → `/vision` nav link (the web client's foundation
  file; AvaVision Phases 4/5 did NOT scaffold `web/` — they added the AvaVision feature into the existing
  web client built by `Specs/web-client/`). **Coordinate with the web-client kit's own Phase Z** if it
  is running: whichever Phase Z runs last adds the nav link and finalizes the web build. Also dedupe any
  AvaVision fetch wrapper Phases 4 and 5 both created (`avavisionApi.ts` vs local session wrappers) into
  one, and optionally promote `/api/avavision/*` helpers into `web/src/lib/apiClient.ts` + add them to
  the web-client MASTER §4.
- **Admin console (PHASE-6-GLUE):** add the `admin_dashboard` import + the `/api/admin/*` aggregation
  dispatch lines to `worker/src/index.ts`; confirm `POSTHOG_PERSONAL_API_KEY` is set as a **secret** in
  prod + staging (`wrangler secret put`, value NOT in repo); **append the seeded admin's Clerk uid to
  `ADMIN_UIDS`** in `worker/wrangler.toml [vars]` (prod + staging) after running
  `worker/scripts/seed-admin.ts` — the password is set in Clerk, never committed; add the conditional
  `Admin → /admin` link to `web/src/components/Nav.astro` (admins only); apply the optional
  `admin_dashboard.sql` migration only if Phase 6 created one (and to the DB it names).
- Small integration shims needed to make the build pass.

## Steps
1. **Inventory.** Read the 6 Graphiti episodes + 6 glue notes. Build a checklist: every shared-file
   change requested, every cross-phase symbol (`VisionSessionScreen`, `VisionPreviewPane`,
   `visionEngineWeb.ts`), every `// PRICING-TBD` placeholder, every temporary scaffold file to dedupe.
2. **Apply PRICING numbers.** From `Specs/avavision-build/PRICING.md`, replace every `// PRICING-TBD`
   in `worker/src/routes/avavision.ts` (min rate, default snapshot cap, `AVAVISION_SNAPSHOT_MODEL`).
3. **Wire the Worker.** Apply the index.ts dispatch, config.ts flag, wrangler.toml migration + var.
   Run `cd worker && npx tsc --noEmit` until clean.
4. **Apply the D1 migration.** Run `worker/migrations/avavision.sql` against **avatok-meta** on prod
   AND staging via the REST API (the project's standard migration recipe — see the memory
   "Wrangler deploy sandbox limit" / "Cloudflare API token"). Verify the tables exist.
5. **Wire the Flutter app.** Apply the registry/sidebar/create-listing entries; reconcile the
   Phase 2 ↔ Phase 3 boundary (`VisionSessionScreen`, `VisionPreviewPane`). Apply pubspec/gradle deps
   + the MoveNet/MediaPipe model assets. (Note: APK builds in CI on push — do NOT run a local
   `flutter build`; just make the code analyze cleanly: `cd app && flutter analyze` if available, else
   eyeball for the documented deferred-wiring errors now being resolved.)
6. **Wire + dedupe the web (inside the existing web client).** Confirm the web-client Phase 0
   foundation is present (do NOT re-scaffold). Add the `Vision` nav link to `Nav.astro`; dedupe the
   AvaVision fetch wrapper into one; ensure Phase 4's studio preview imports Phase 5's
   `visionEngineWeb.ts` (no duplicate engine); confirm the MediaPipe/TF.js bundles are lazy-loaded only
   on vision pages (the documented §7 deviation). Run `cd web && npm run build` until green;
   `npm run preview` and smoke-test marketplace → agent page → studio publish → session (camera consent,
   overlay, score badge, 1fps Live, two-way audio, "Analyze" snapshot, countdown wrap-up, stop/billing).
   If the web-client kit's own Phase Z owns the final web commit, coordinate so the nav link + build are
   done once, by whichever Phase Z runs last.
7. **End-to-end smoke (staging).** Create a vision agent from a template, publish, Call-Now from a
   second identity, confirm: token mints with video locked LOW/1fps, overlay+score render, agent talks,
   snapshot returns an annotated image, session stop settles 50/50 + refunds unused, slot frees, stats
   show avg/peak score + snapshot usage. Flip `avavisionEnabled=false` and confirm the kill switch
   blocks sessions.
8. **Clean up.** Delete the Phase 0 throwaway `Specs/avavision-build/spike/` (keep `PRICING.md`).
9. **Commit once + push.**
   - Stage the worker + app + web + `Specs/avavision-build/` changes. Do not leave the spike staged.
   - One clear commit, e.g.
     `feat(avavision): creator vision-agent marketplace — worker API, Android session, web client (Gemini Live + MediaPipe/MoveNet + Agentic-Vision snapshot)`.
   - Push to the working branch.
10. **Deploy.** Deploy the Worker (`avatok-api`) per the project recipe (install `wrangler@^4` in `/tmp`,
    `CLOUDFLARE_API_TOKEN` from `secrets/cf_token`); deploy consumers if changed; deploy the web (CF
    Pages) if the foundation is ready (else note it as a follow-up). Verify prod responds on
    `/api/avavision/templates` and `/api/avavision/marketplace`.
11. **Graphiti push log (project standing rule).** After the push, write a **detailed** episode:
    `add_memory(group_id="proj_avaflutterapp", name="AvaVision PHASE-Z complete — glued, pushed,
    deployed", episode_body="...commit hash, every file, D1 migration applied, deploy targets,
    smoke-test results, kill-switch verified, any follow-ups (iOS track, web foundation)...")`.

## Acceptance checklist
- [ ] Worker `tsc --noEmit` clean; all `avavision` routes dispatched; `avavisionEnabled` flag live.
- [ ] `avavision.sql` applied to avatok-meta prod + staging; tables verified.
- [ ] App registry/sidebar/create-listing wired; Phase 2↔3 boundary reconciled; deps/assets added.
- [ ] Web builds green; one canonical scaffold; preview smoke-tests pass for the full funnel.
- [ ] Staging end-to-end works incl. snapshot + settlement + slot free + kill switch.
- [ ] No Durable Object added; slot cap = D1 counting; snapshot cap = D1 counter.
- [ ] Committed **once** and pushed; Worker (+web if ready) deployed; post-push Graphiti episode written.
