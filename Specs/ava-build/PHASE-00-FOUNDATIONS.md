# Phase 0 — Foundations & Contracts (SOLO, runs first)

**Read `00-MASTER-PLAN.md` first.** You run alone before any other phase. Your job
is to make every shared/"hot" file a stable registry or contract so the next ~10
agents can work in parallel without ever editing the same file.

**🚫 DO NOT commit or push. Leave the tree dirty for Phase 11.**

## Depends on
Nothing. Blocks every other phase.

## OWNED FILES (you are the only phase allowed to touch these)
- `app/lib/core/feature_flags.dart`
- `app/pubspec.yaml`
- `worker/wrangler.toml`
- `worker/src/api.ts`
- `worker/src/routes/config.ts`
- `worker/src/do/inbox.ts`
- `app/lib/core/app_registry.dart`
- `app/lib/features/settings/settings_screen.dart`
- `app/lib/features/avatok/chat_thread.dart`
- `app/lib/main.dart`
- NEW: `app/lib/core/ava_contracts.dart`, `app/lib/core/ava_bootstrap.dart`,
  `app/lib/core/paid_feature.dart`, `app/lib/features/settings/settings_registry.dart`,
  `app/lib/features/settings/sections/` (empty dir + README),
  `worker/src/lib/ava_kinds.ts`, `Specs/ava-build/INTEGRATION-NOTES.md`

## Tasks
1. **Flags** (`feature_flags.dart`): add `focusMode`, `aiEnabled` (derived from
   AvaAiStore at runtime — expose helper), `webSearchEnabled`, `fileAnalysisEnabled`,
   `openChatUncapped`, `dailyAvaTurnLimit`, `guardianEnabled`, `companionEnabled`,
   `generativeEnabled`. Sensible defaults per the proposal.
2. **Deps** (`pubspec.yaml`): add everything later phases need — on-device vector
   store (objectbox or sqlite-vec binding) + FTS, any HTTP/SSE client for Strata,
   image display already present. Pin versions; don't remove existing deps.
3. **Bindings** (`wrangler.toml`): add DO bindings (`AVA_AGENT`, `BACKUP`), R2
   bucket for backups, any queues, and vars placeholders. Keep existing intact.
4. **Message-kind + visibility contract**:
   - `worker/src/lib/ava_kinds.ts`: export `AvaKind = 'ava'|'ava_private'|'ava_status'`
     and the JSON body shapes.
   - `inbox.ts`: extend `append` to accept `scope: 'thread' | 'to:<uid>'`
     (default `'thread'`); when `to:<uid>`, the message is delivered/synced ONLY to
     that uid — enforced server-side. Add an `ava_status` transient broadcast helper
     (the "working…" chip) that does NOT persist.
5. **chat_thread.dart**: render `ava` + `ava_private` bubbles in a **feminine
   accent color** (distinct from lime/card), with an "Ava" label; render
   `ava_status` as an inline "Ava is working…" chip. Make rendering **generic** so
   any phase posting these kinds needs no UI change. Add a composer affordance hook
   for `@ava` (P3 fills the behavior via a callback contract).
6. **SettingsSectionRegistry**: `settings_registry.dart` defines `SettingsSection`
   (title, builder, order) + a registry. Refactor `settings_screen.dart` to render
   registered sections (keep existing Account/AvaBrain/Backup/AvaAI as registered
   sections). Feature phases will add sections under `settings/sections/`.
7. **PaidFeature** (`paid_feature.dart`): a wrapper widget that checks wallet
   balance and either runs the action (with a cost preview) or opens the top-up
   sheet; `kMinTopUpUsd = 5`; a reusable **PAID badge** widget.
8. **Routes** (`api.ts`): register all new routes from §4 of the master plan,
   importing handler names the owner phases will create (ok if missing until P11).
9. **app_registry.dart**: add a `focusMode` helper that returns AvaTok + account
   essentials only (P1 consumes it). Add any new app entries needed.
10. **AvaBootstrap.init()** (`ava_bootstrap.dart`) called once from `main.dart`:
    central place for memory/tool registration hooks (empty registrations now;
    phases append via their own files).
11. Create `INTEGRATION-NOTES.md` with a header and the append format.

## Acceptance
- Every contract in master-plan §4 exists and is importable.
- Hot files compile against stubs; no feature logic added here.
- `settings_screen.dart` renders via the registry; existing sections still show.
- `chat_thread.dart` renders the three Ava kinds generically.
- Nothing committed. `INTEGRATION-NOTES.md` seeded.
