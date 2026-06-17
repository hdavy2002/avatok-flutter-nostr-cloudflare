# Phase 1 — Menu Focus Mode + Paid Gating UI

**Read `00-MASTER-PLAN.md` first. 🚫 No commit/push — leave the tree for Phase 11.**

## Depends on
P0 (uses `focusMode` flag, `app_registry.focusMode` helper, `PaidFeature`, badge).

## OWNED FILES
- `app/lib/shell/ava_shell.dart`
- `app/lib/shell/ava_sidebar.dart`
- NEW: `app/lib/shell/focus_mode.dart` (any helper logic)
- NEW: `app/lib/features/settings/sections/focus_section.dart` (toggle to show/hide
  the rest of the apps), registered via SettingsSectionRegistry.

## DO NOT TOUCH
`app_registry.dart`, `feature_flags.dart`, `settings_screen.dart`, `paid_feature.dart`
(all owned by P0 — consume them, don't edit).

## Tasks
1. When `focusMode` is on, the sidebar renders **AvaTOK + account essentials only**
   (Wallet stays — paid features need it). Use P0's `app_registry.focusMode` helper.
2. Make it reversible: a Settings toggle (focus_section.dart) flips `focusMode`.
3. Apply the **PAID badge** (P0 widget) to any sidebar/app entry that is premium-gated
   so users see what needs top-up. Wrap premium entry points in `PaidFeature`.
4. Keep non-AvaTok apps **registered but hidden** (don't delete entries).

## Acceptance
- Focus mode hides non-AvaTok apps; toggling it back restores them.
- Wallet remains reachable. PAID badges show on premium items.
- Only OWNED FILES changed. No git ops. Note appended to INTEGRATION-NOTES.md.
