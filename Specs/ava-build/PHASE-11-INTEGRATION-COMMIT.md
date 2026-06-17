# Phase 11 — Integration, Verification & Single Commit/Push (SOLO, last)

**Read `00-MASTER-PLAN.md` first.** You run alone, after every other phase reports
done. You are the **only** phase allowed to use git. No new features — reconcile,
verify, ship once.

## Depends on
ALL phases (P0–P10).

## Inputs
`Specs/ava-build/INTEGRATION-NOTES.md` (every phase appended its files, stubs,
assumptions, and "needs from integration").

## Tasks
1. **Reconcile wiring:** confirm every route registered in `api.ts` has a real
   handler; every `SettingsSection` is registered; every `AvaTool` is registered in
   `AvaBootstrap.init()`; `ava`/`ava_private`/`ava_status` render correctly; the
   `to:<uid>` private scope is honored end-to-end (guardian warning never leaks).
2. **Resolve cross-phase TODOs** listed in INTEGRATION-NOTES.md (e.g., a phase that
   needed a change in another phase's file). Make those edits now — you own the merge.
3. **Verify** (do not assume green):
   - Worker: typecheck/build (`wrangler`/`tsc` as configured).
   - Flutter: rely on CI (no local toolchain). If pushing a branch triggers CI, do
     that and read results; fix integration-only breakage.
   - Spot-check the key flows: onboarding Add-AI/skip, settings Ava-AI connect/remove,
     `@ava` in 1:1, an image gen, a private guardian warning, focus mode on/off.
4. **Update docs:** flip `Specs/AVA-IN-CHAT-AI-PROPOSAL.md` phase rows to done where
   true; note anything deferred.
5. **One commit, one push.** A single descriptive commit covering all phases; push.
6. **Graphiti episode** under `proj_avaflutterapp` (per the autolog-on-push rule):
   summarize what shipped, files, flags, and any deferred items.

## Acceptance
- Build/typecheck pass (or CI green); the spot-check flows work.
- Exactly **one** commit and **one** push for the whole effort.
- Graphiti episode written. INTEGRATION-NOTES.md TODOs all resolved or explicitly
  deferred with reasons.
