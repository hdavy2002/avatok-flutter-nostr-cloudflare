# 08-flutter-ui — REPORT

Lane: Flutter app visible surfaces. Worked from `plan/SPEC.md` / `plan/BRIEFS.md`,
not from lane 01's taxonomy output (per instructions). Commit: `e17ea08e`
(`[SAATHUM-08] Narrow the Flutter app's visible surfaces to Saathum's scope`).

## Starting state

This worktree already had three files modified-but-uncommitted when I started
(no prior REPORT.md, no prior commit on this branch for the rename): the
sidebar's Subscribe tile hidden, the marketplace hub's AI voice/vision
creator-studio tiles hidden, and the wizard's category dropdown filtered
against `find_your_people`. I kept all three (they match the brief) and
folded them into this lane's single commit along with the new work below.

## What I found before changing anything

The brief's wizard bullet list ("companionship type, discounts step,
per-person limit, time slots, publish fee screen, free-session toggle") reads
as six live UI elements. I traced the actual reachable code first and found
only two of the six are live in the wizard that real users hit:

- **The active, reachable wizard is `NativeListingWizardScreen`** (pushed
  from `marketplace_hub.dart`, `my_listings_screen.dart`, `ava_shell.dart`).
  It is one large self-contained file — it does NOT use the `steps/step_1..
  step_8*.dart` files in `native_listing/steps/`. I grepped for imports of
  every one of those step files and of `SellListingFlow` (a second,
  buy/sell/social/dating/matrimony wizard with its own fee-quote "publish
  fee" panel) across `lib/` and found zero call sites outside their own
  definitions. Both are dead code — unreachable from any menu, tile, or
  route. This is where "discounts step" (well, `_feePanel`/`ListingFeeQuote`
  UI), "per-person limit" (`max_per_booking` UI), and "time slots"
  (`step_4_time.dart`'s slot picker) actually live in the codebase, and
  they're already invisible because nothing navigates there.
- **Discounts** in the live wizard ARE present but already gated behind
  `RemoteConfig.listingPromotionsEnabled`, confirmed `false` in both prod
  (cache-busted curl, see below) and worker DEFAULTS — already correctly
  dark, no UI change needed.
- **Per-person limit / time slots** have no UI at all in the live wizard —
  `max_per_booking` is never read or written there (confirmed by grep); the
  server default (4) applies untouched.
- **Publish fee screen** exists only in the dead `SellListingFlow`.
- **Companionship type** and **free-session toggle** are real, live UI in
  the reachable wizard — see changes below.

Given that, I did NOT touch the dead files (`steps/*.dart`, `sell_listing_
flow.dart`) — SPEC says nothing is deleted, and these are already both
unreachable and out of my brief's literal ask (hiding *visible* surfaces).
I flagged them here instead of silently leaving them unmentioned.

## Changes made

**`app/lib/features/marketplace/marketplace_browse.dart`** — the "three
shelves become two" ask. The shelf loop iterates `kListingGroups` (the
generated Dart mirror of `Specs/listing-taxonomy.json`, owned by lane
01-taxonomy — HARD RULE 3 forbids hand-editing it). Added a `continue` for
`group.id == 'find_your_people'` at the top of that loop, so the
companionship shelf never renders regardless of whether lane 01's
regeneration has landed yet, and without touching the generated file. This
also removes its blip/filter row, covering "search filters" for that shelf.

**`app/lib/features/marketplace/native_listing/native_listing_wizard_screen.
dart`** — the free-entry ("free-session") toggle. It already fails closed
server-side (`freeEntryAllowlistOnly`, admin/allowlist-only) and was gated
`if (_freeEntryAllowed || _freeEntry)`. Changed to `if (_freeEntry)`: the
switch is never offered as a fresh option to anyone, even an allowlisted
admin account, but a listing that is *already* free still shows it so its
owner can turn it off (mirrors the existing care taken for the companionship
category filter a few lines above, which keeps a hidden category visible
only when it's the value already on an existing listing). `_freeEntryAllowed`
is still fetched and assigned but no longer read elsewhere in the file; this
is an `unused_field` info-level lint only (verified `flutter analyze` is run
with `--no-fatal-infos --no-fatal-warnings` / `|| true` in every workflow
that calls it, so this cannot fail CI).

**`app/lib/features/marketplace/marketplace_hub.dart`** (already-uncommitted
work from before I started, kept) — hid the AvaVoice/AvaVision creator-studio
tiles. I additionally fixed the "Create listing" tile's subtitle, which read
"Sell, buy or post a social listing" — stale copy describing the dead
`SellListingFlow`, not what the tile actually opens (`NativeListingWizard
Screen`, live event or 1:1 consult only). New copy: "Post a live event or a
1:1 consultation." This is the one "empty-state string that names a removed
feature" I found on a *reachable* screen (see the localization note below).

**`app/lib/shell/ava_sidebar.dart`** (already-uncommitted work from before I
started, kept) — hid the Subscribe tile and its free-plan pill's tap-through.
Team was already commented out before this batch. I verified `TeamHomeScreen`
and the sidebar's `'subscribe'`/`'team'` destination keys have no other
caller anywhere in the app (`ava_shell.dart`'s and `shell_v2/shell_
destinations.dart`'s matching `case` arms are now dead switch cases, same
pattern as other hidden features in this codebase) — hiding means hidden in
this codebase's established idiom of "no widget calls the destination key."

**`shared/i18n/source/app.json`** + regenerated **`app/lib/core/localization/
ui_messages.dart`** — the source of the stale marketplace-hub subtitle above.
This pair is itself a generated-mirror relationship (`app/tool/generate_ui_
catalog.py`, local/offline/no network), so I edited the JSON source and ran
the generator rather than hand-editing the Dart enum, same principle as HARD
RULE 3 for the taxonomy. The regenerated `ui_messages.dart` also picked up an
unrelated pre-existing ordering fix (8 `m_commercial_quality_*` keys were
appended out of the generator's alphabetical order by some earlier,
non-regenerated edit) — harmless, but I want it visible rather than silent.
I deliberately did **not** commit the regenerated `ui_locales.dart`: running
the generator also touched it, but only in Python-vs-Dart quote-style
formatting plus one Urdu locale name that appears to have gained diacritics
in `shared/i18n/locales.json` from unrelated, still-unregenerated work. That
file is outside my lane and outside this task; I reverted it with `git
checkout --` so this commit doesn't carry someone else's in-flight change.

## Verified prod flag state (HARD RULE 7 — never trust DEFAULTS)

```
curl -s -H 'Cache-Control: no-cache' "https://api.avatok.ai/api/config?cb=$RANDOM"
```

| Flag | Worker DEFAULTS | **Live prod** |
|---|---|---|
| `listingFeeEnabled` | `false` | **`true`** |
| `agentListingsEnabled` | `false` | `false` |
| `freeSessionsEnabled` | `false` | **`true`** |
| `listingPromotionsEnabled` | `false` | `false` |
| `listingMaxPerBookingEnabled` | `false` | `false` |
| `listingSlotsEnabled` | `false` | `false` |
| `listingPublishKycRequired` | `true` | `false` |

**Flagging for the coordinator / lane 02:** `listingFeeEnabled` and
`freeSessionsEnabled` are live `true` in production right now, which
contradicts SPEC.md's "Features being switched off" list — someone needs to
flip the KV override, not just the DEFAULTS block, or this batch ships with
those two still live. I did not touch worker config/KV (not my lane) but
did not want this to go unreported. Separately, worker DEFAULTS has
`listingPublishKycRequired: true` even though SPEC says to "confirm already
off" — prod KV already overrides it to `false`, so prod itself is fine, but
the DEFAULTS value contradicts the SPEC's premise and is worth lane 02
double-checking.

None of this changed my Flutter-side conclusions: the free-entry toggle in
the live wizard was already gated by a *different*, stricter mechanism
(`freeEntryAllowlistOnly` / per-account `freeEntryAllowed()`, not
`freeSessionsEnabled`) that the app has never wired to `freeSessionsEnabled`
at all, and I tightened that gate further regardless of what either flag
says in prod. The dead `SellListingFlow`'s fee panel (gated by
`listingFeeEnabled`) is unreachable from any menu regardless of the flag's
value, so its being `true` in prod does not expose anything in the app today.

## What I deliberately did not touch

- **Per-category hiding within `india_goes_live` / `book_their_time`** (e.g.
  hiding `live_cooking`, `live_trek`, glow_up sub-categories while keeping
  Puja/Temple/Astrologers) — this flows through `GET /api/explore/categories`
  and the generated `listing_groups.dart` mirror, both owned by lanes
  01/02/03. The Flutter screens I touched (`marketplace_browse.dart`,
  `native_listing_wizard_screen.dart`, `explore_home.dart`) all fetch
  categories from the server or the generated mirror rather than
  hardcoding a category list, so once those lanes land, the per-category
  hiding reaches the app with no further Flutter change needed. I verified
  this by reading every category-list call site in `lib/features/explore/`
  and `lib/features/marketplace/` — none hardcode the 42-category list.
- **`ai_voice_agent_screen.dart`'s own Subscribe upsell** (`_goSubscribe()`,
  a wallet-entitlement gate for AvaVoice calling with Ava — a different
  feature from the marketplace's `ai_voice_agents` shelf). It still
  navigates to `SubscribeScreen` on a free wallet. This is reachable
  (`ava_shell.dart`, `companion_thread.dart`), unlike the sidebar/shell_v2
  Subscribe routes I hid. I left it: it's an existing AI-companion paywall
  unrelated to the marketplace/settings surfaces this brief names, and per
  SPEC "dark the server paths behind [subscription plans], not just the UI"
  is explicitly lane 02's job — if a `subscriptionPlansEnabled`-style flag
  lands there, this call site (and `SubscribeScreen`/wallet-entitlement
  logic generally) is where it would need to be consulted. Flagging it here
  so it isn't silently missed by whichever lane owns that flag.
- **`SellListingFlow` and the orphaned `native_listing/steps/*.dart`
  files** — dead code, not deleted per SPEC's "nothing is deleted" rule, and
  already fully unreachable, so leaving them alone doesn't violate "hidden
  in the UI."
- **Number picker / onboarding number gate** — untouched, as instructed.
- **Web (`web/`), worker (`worker/`), and `Specs/listing-taxonomy.json`** —
  not my lane.

## Verification

No local Flutter/Dart toolchain exists on this machine by owner decision
(2026-09-10, per CLAUDE.md) — could not run `flutter analyze` or build. I
verified by:
- Grep-based reachability tracing for every screen/route touched or
  considered (constructor call-site search across `lib/`) rather than
  assuming from file names.
- Brace-balance sanity check on every edited file (`marketplace_browse.dart`
  and `marketplace_hub.dart` and `ava_sidebar.dart` balanced; the one
  pre-existing imbalance in `native_listing_wizard_screen.dart` — 337 open /
  336 close braces — was already present at `HEAD` before any edit this
  session, confirmed via `git show HEAD:...`, and my two edits there added
  zero net braces).
- Re-ran `app/tool/generate_ui_catalog.py` (local, offline, no network) after
  the `app.json` edit and diffed the output before committing.
- Cache-busted curl of `/api/config` for the flag table above.

**Gap:** I could not do a real device/emulator screenshot pass (no adb, no
emulator, no Flutter — see CLAUDE.md's "no local build toolchain" section)
to visually confirm the marketplace shelf count or the wizard's free-entry
toggle. This is a code-level, reachability-verified change, not a
UI-tested one — flagging per the task's "monitor for regressions" guidance;
the next build should be smoke-tested for these two screens specifically.
