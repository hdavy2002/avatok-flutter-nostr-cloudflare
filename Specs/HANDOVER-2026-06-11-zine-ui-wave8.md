# HANDOVER — Zine UI redesign, final cleanup (Wave 8)

**Date:** 2026-06-11 · **Repo:** avatok-flutter-nostr-cloudflare · **Branch:** main
**State:** Waves 1–7 DONE and pushed (commits `b964b4b` → `03cd088`). One cleanup wave left.

## What this task is

The entire Flutter app (`app/`) was migrated to the AvaTOK **zine design system**.
Binding spec: **`Specs/proposals/AVATOK-DESIGN-SYSTEM.md`** — read it first.
Canonical Flutter implementation (DO NOT redesign these, just use them):

- `app/lib/core/ui/zine.dart` — tokens: `Zine.*` colors (paper/ink/lime/coral/blue/blueInk/lilac/mint/mintInk), radii, **hard offset shadows only** (`Zine.shadow`, `shadowSm`, `shadowXs`, `shadowFocus`, `shadowError`), `ZineText.*` type helpers (Fredoka display / Nunito ≥600 body / Space Mono 700 uppercase labels).
- `app/lib/core/ui/zine_widgets.dart` — components: `ZineButton` (variants lime/blue/coral/ghost, `loading`, `fullWidth`), `ZineCard`, `ZineCardHead`, `ZineField` (label, leadText/leadIcon lime cell, trailing, `error`, `inputFormatters`), `ZineChip`, `ZineSticker` (kinds ok/no/hint/plain), `ZineBackButton`, `ZineIconBadge`, `ZineStepPips`, `ZineCrest`, `ZineMarkTitle`, `ZineLink`, `ZineToggle`, `ZineDropdown`, `ZineAppBar` (PreferredSizeWidget; `title`, `markWord`, `tag`, `actions`), `ZinePaper`, `ZineSuccessOverlay`, `ZineEmptyState`, `ZineErrorMsg`, `ZinePressable` (press-into-paper physics).
- `app/lib/core/theme.dart` — `AvaColors` is a **legacy alias** already re-pointed at the zine palette; global `ThemeData` is done. In code you touch, replace `AvaColors.*` with `Zine.*`.
- Fonts are bundled in `app/assets/fonts` (pubspec done). Icons: `phosphor_flutter` only — `PhosphorIcon(PhosphorIcons.name(PhosphorIconsStyle.bold|fill))`. Phosphor calls are NOT const (a `const` list holding them must become `final`).

Good migrated examples to copy patterns from:
`features/onboarding/handle_claim_screen.dart`, `features/auth/sign_in_screen.dart`, `features/listings/create_listing_flow.dart` (ink-rail stepper), `features/verse/verse_screen.dart` (money/ledger/metric cards), `features/avachat/avachat_screen.dart` (lilac AI), `features/avatok/chat_thread.dart` (bubbles §7.14), `features/avalive/live_room_widgets.dart` (over-video chrome: `LiveCircleButton`, `LiveInkPill`).

## Hard rules (violations = rejected)

1. NO gradients. NO blurred shadows (only `Zine.shadow*`, blurRadius 0, or none). NO dark surfaces. NO pure #000/#FFF fills.
2. Fonts only via `ZineText` helpers. White text ONLY on coral fills (or inside ink-alpha overlay bands over live video).
3. ONE lime primary button per screen; secondary = blue/ghost/`ZineLink`.
4. Borders ≥2.5px `Zine.ink` (2px for tiny avatars/pips); radii: cards 22, tiles 14–18, pills 100.
5. AI = lilac, money/success = mint/mintInk, errors/live/destructive = coral, links/accent text = blueInk.
6. **VISUAL-ONLY**: never change logic, API calls, analytics, navigation, per-account scoping (`scopedKey`/`AccountScope`), class names or public signatures.
7. Friendly copy voice (§9): "Let's go", "All caught up" — never "Submit"/"OK".
8. Video/call screens: video content stays; chrome = ink-bordered circles; overlay dims = `Zine.ink.withValues(alpha: ..)` flat bands (allowed); audio-call screens are paper.
9. Code MUST compile — there is NO local Flutter toolchain (CI builds the APK on push). Check every widget param against `zine_widgets.dart` before using it. Make surgical edits in big files.

## REMAINING WORK (Wave 8 — the full list)

These are the only files still off-system (they reference `AvaColors.` or gradients):

| File | What to do |
|---|---|
| `app/lib/features/avabrain/agent_inbox_screen.dart` | AI surface → lilac accents, zine rows/cards, ZineAppBar, ZineEmptyState |
| `app/lib/features/avabrain/brain_settings_screen.dart` | Settings pattern: mono kickers, ZineToggles, zine cards (see settings_screen.dart) |
| `app/lib/features/avalive/avalive_discovery.dart` | Has a gradient — remove. Listing tiles like explore widgets; coral LIVE stickers |
| `app/lib/features/avavoice/widgets.dart` | Shared `AgentCard`/`AvailabilityChip`/`VisionBadge`/`pickLanguage` — keep names/signatures EXACTLY, zine internals (lilac AI) |
| `app/lib/features/avavoice/booking_sheet.dart` | Paper sheet, ZineField/ZineChip slots, lime confirm |
| `app/lib/features/avavoice/studio/voice_picker.dart` | Voice rows with lilac badges, selected = lilac tile + ink check |
| `app/lib/features/avavoice/studio/my_agents_screen.dart` | Zine cards + status stickers, lime "New agent" |
| `app/lib/features/avavoice/studio/agent_dashboard.dart` | Metric cards (§7.11) + ledger rows (§7.10), mint money |
| `app/lib/features/consult/prejoin_screen.dart` | Paper pre-join: camera preview in ink-bordered tile, device dropdowns → ZineDropdown, lime Join |
| `app/lib/core/avatar.dart` | Uses `AvaColors.thumbGradients` (already flat colors). Optional polish: 2px ink ring on Avatar. Low risk — many call sites; keep signature |
| `app/lib/core/wallpaper.dart` | Chat wallpaper presets still real gradients. Replace each preset with flat zine-tint colors (paper, blue/lilac/mint/lime at low alpha over paper). Keep API/names |
| `app/lib/main.dart` | `_UpdateRequiredScreen` → zine (paper, crest-style seal, Fredoka headline); also `CircularProgressIndicator(color: AvaColors.brand)` → `Zine.blueInk` |

After these: `grep -rn "LinearGradient\|RadialGradient\|AvaColors\." app/lib --include='*.dart'` should only hit `core/theme.dart` (the alias definition itself).

## Verify & ship (per project conventions)

1. Self-review each file (no analyzer available). Common pitfalls: const lists with Phosphor icons (→ `final`), `ZineChip` has no icon param, `ZineCard.radius` is a `double`, `int.clamp` returns `num`.
2. Scan: the grep above + `grep -rn "blurRadius: *[1-9]" app/lib`.
3. Commit message style: `feat(ui): zine wave 8 — final cleanup (avabrain, avavoice studio, wallpapers, update screen)`.
4. **Push from the user's Mac, not a sandbox** (`cd /Users/davy/Documents/websites/avaTOK-2-Flutter && git push origin main`) — a graphify pre-commit hook will rebuild the graph; that's normal. CI (GitHub Actions) builds the APK; that's the compile gate.
5. After the push, write a Graphiti episode: `add_memory(group_id="proj_avaflutterapp")` — ALWAYS pass that exact group_id — summarizing files changed + commit hash.

## Known intentional decisions (don't "fix")

- Dark welcome/story-viewer/conference surfaces were deliberately replaced with paper (dark is forbidden).
- Unread badges are lime (not red); missed calls coral; incoming mint.
- AvaLive host now goes live only on the explicit lime "Go live" tap (was auto-publish).
- `_field` private helpers in onboarding kept instead of ZineField where `inputFormatters` were needed before ZineField gained that param — fine to leave.
- QR codes keep white backing (scannability).
- `calendar_data.dart` `kSourceStyles` colors are unused by migrated screens (only `.label` read) — leave.
