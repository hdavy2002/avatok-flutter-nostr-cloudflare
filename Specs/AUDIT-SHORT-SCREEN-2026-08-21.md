# [RESP-SMALL-3] Short-screen audit of the 2026-08-21 UI redesign

**Date:** 2026-08-21 · **Scope:** the 12 commits that landed today (`200b5ff5` → `95d1035a`)
**Reference devices**

| name | logical size | width class | `chromeScale` | app type bump |
|---|---|---|---|---|
| BlackBerry KEYone/KEY2 class (the tester's phone) | **393 x 590 dp** | `regular` | **1.0** | **1.22** |
| genuinely tiny phone | **320 x 480 dp** | `compact` (320 is *not* `< xcompactMax`) | 0.85 | 1.10 |
| ordinary handset (control) | 393 x 852 dp | `regular` | 1.0 | 1.22 |

## The central finding

`RESP-SMALL-1` (`tool/ship_manifest.json`, commit `fd19115a`) fixed the reported symptom by
ramping the app-wide type bump and adding `ZineBreakpoints.chromeScale` — **both keyed off
WIDTH**. `app/lib/core/ui/breakpoints.dart` has no height input at all:
`classify()` (:24), `isXCompact()` (:69) and `chromeScale()` (:84) all read
`MediaQuery.sizeOf(context).width`.

The QWERTY phone is **393dp wide**. It therefore classifies `regular`, takes the FULL 1.22
type bump, and `chromeScale` returns **1.0** — every relief RESP-SMALL-1 added misses this
device entirely. Its problem is that it is **~30% shorter** than the phone every layout in
this repo was eyeballed on, and nothing in the codebase keys off height.

Two of today's constructs cross the line from "tight" to "unreachable" on exactly this
geometry, and neither has anything to do with width. Both are fixed below.

---

## Findings, ranked

### 1. BREAKS — `_openWriteHelp` bottom sheet loses its last two rows

**File:** `app/lib/features/avatok/chat_thread/composer.dart:516` (pre-fix line numbers)
**Construct:** `showModalBottomSheet<String>(context: …, backgroundColor: Colors.transparent,
builder: …)` — **no `isScrollControlled`** — whose body is a non-scrolling
`Column(mainAxisSize: MainAxisSize.min, …)` holding five `_writeHelpRow` entries
(`composer.dart:552`).

Flutter's `_ModalBottomSheetLayout` caps a sheet at **9/16 of the screen height** unless
`isScrollControlled: true`. Measured against the row geometry actually in the file —
`ZinePressable(padding: symmetric(vertical: 12))` around a two-line column of
`ADText.rowName()` (15sp, `avatok_dark.dart:628`) over `ADText.preview()` (14sp, :636),
plus `Padding(bottom: 10)`:

| device | sheet cap (9/16) | content height @ app bump | result |
|---|---|---|---|
| 393 x 852 (control) | 479dp | ~468dp @1.22 | fits — this is why it shipped |
| **393 x 590** | **332dp** | **~468dp @1.22** | **~136dp overflows; "Shorter & clearer" and "Reply ideas" are laid out past the bottom of the sheet and cannot be scrolled to** |
| **320 x 480** | **270dp** | **~447dp @1.10** | **~177dp overflows; three of five rows unreachable** |

A `Column` that overruns does not scroll and does not shrink — it paints the overflow stripe
and the children past the edge are simply not there for the user. "Reply ideas" is the last
row, so the whole reply-suggestion feature is dead on this phone.

**Fix applied:** `isScrollControlled: true` (lifts the cap to the full screen) **and** the
five rows wrapped in `Flexible(child: SingleChildScrollView(child: Column(min)))` — the same
idiom `_pickTransLang` (`composer.dart:796`) already uses in this file, so a large OS
accessibility scale degrades to scrolling instead of clipping.

### 2. BREAKS — `_showReplyIdeas` bottom sheet drops its last suggestion

**File:** `app/lib/features/avatok/chat_thread/composer.dart:844` (pre-fix)
**Construct:** identical shape — `showModalBottomSheet<void>` with no `isScrollControlled`,
body a `Column(min)` with `for (final idea in ideas) … Text(idea, style: ADText.rowName())`.

`ComposerAi.parseIdeas` (`core/composer_ai.dart:123`) returns `.take(3)`, but the tiles carry
**no `maxLines`** — model output routinely wraps to three or four lines at 15sp x 1.22 in a
329dp-wide tile. Header + caption ≈ 100dp, then 3 x (8 + 24 + 3 lines ≈ 55) ≈ 260dp, total
≈ 372dp against a 332dp cap at 393x590 and a 270dp cap at 320x480. The third idea — often
the one the user wants — is off the bottom with no scroll.

On 393x852 (479dp cap) it fits until the ideas get wordy, which is why it was never reported.

**Fix applied:** same as finding 1 — `isScrollControlled: true` plus `Flexible` +
`SingleChildScrollView` around the tile list. The header and caption stay pinned.

### 3. BREAKS — audio call screen: the header row is covered by the content scroll view

**File:** `app/lib/features/avatok/call_screen.dart:1858` (pre-fix) — `if (light)
Positioned.fill(child: SingleChildScrollView(…))`, with the header `SafeArea > Padding > Row`
(back = minimize, centred title, `_MinimizeButton`) sitting EARLIER in the same `Stack`
children list at `:1777`.

Later children paint on top, and `Scrollable` installs its gesture recogniser with
`HitTestBehavior.opaque`, so the full-bleed scroll view swallows every tap over the header
band. `AdBackButton` (`avatok_dark.dart:921`, 40x40) and `_MinimizeButton` are painted but
dead — the user cannot minimise a call from the header on any device. That part is
size-independent and predates today (`[NOTE-COMPOSER-LAYOUT 2026-07-12]`, comment at :1852).

What today's redesign added is the **visual** half, and it is height-specific. Content is
`Center`ed inside `ConstrainedBox(minHeight: screenH - viewInsets - (controlPanelHeight +
inset))` with `controlPanelHeight = connected ? 350 : 116` (:1525) and scroll padding
`fromLTRB(24, 0, 24, …)` — **top padding zero**:

| device (ringing) | box minHeight | hero + sticker | top gap after centring | header occupies |
|---|---|---|---|---|
| 393 x 852 | 720dp | ~410dp | 155dp | ~76dp — clear |
| **393 x 590** | **458dp** | **~410dp** | **24dp** | **~76dp — the hero paints through the peer's name** |
| **320 x 480** | **348dp** | **~340dp** | **4dp** | **~76dp — same, worse** |

**Fix applied:** `Positioned.fill` → `Positioned(top: _headerReserve(context), left: 0,
right: 0, bottom: 0, …)`, with a new `_headerReserve(BuildContext) =>
MediaQuery.padding.top + 72` on the state, subtracted from `minHeight` as well. The header is
now outside the viewport: visible, tappable, and never painted over. `minHeight` is also
`.clamp(0.0, double.infinity)`d — see finding 4.

### 4. BREAKS (latent) — negative `BoxConstraints.minHeight` on a connected call

Same expression, `call_screen.dart:1863` (pre-fix). `screenH - viewInsets.bottom -
(controlPanelHeight + inset)` with `controlPanelHeight = 350` once connected: open the
text-note composer on a 590dp screen and the keyboard (~300dp) makes this
`590 - 300 - 366 = -76`. A negative `minHeight` fails `BoxConstraints.debugAssertIsValid` in
debug and is undefined in release. On an 852dp phone the same arithmetic stays positive,
which is why it has never fired.

**Fix applied:** `.clamp(0.0, double.infinity)`.

### 5. TIGHT (not fixed) — the hero composition itself is sized purely from WIDTH

**File:** `app/lib/features/avatok/call_hero_composition.dart:58-63`

```dart
final available = MediaQuery.of(context).size.width - 48;
final w = math.max(200.0, math.min(maxWidth, available));
final h = w * g.vbH / g.vbW;
```

`_kHeroRinging` (:141) is viewBox 340x350 — **taller than it is wide** (verified against
`app/assets/illustrations/06-in-call-illo-1.svg`: `viewBox="0 0 340 350"`, orbit
`cx="170" cy="224" r="94"`; illo-2 is `viewBox="0 0 320 300"`, `cx=160 cy=150 r=92`). There is
**no height input and no height clamp**.

- 393dp wide → `available` 345 → `w` = 340 → **h = 350dp**, i.e. **59% of a 590dp screen** and
  73% of the 458dp box it centres in.
- 320dp wide → `w` = 272 → h = 280dp = **58% of a 480dp screen**.
- Connected motif: h = w x 300/320 → 318dp / 255dp.

This is **not** BREAKS: the composition lives inside the `SingleChildScrollView`, so once it
stops fitting the screen scrolls and everything below (sticker, failure note, outcome menu,
Retry button) is reachable. It is ugly-but-usable. The correct fix is a height clamp —
`h = min(h, maxViewportFraction * MediaQuery.sizeOf(context).height)` with `w` re-derived
from `h` — but that changes the shipped look of a screen the owner signed off on this
morning, so it is documented, not done. It is the single best consumer of the height helper
proposed at the bottom.

### 6. TIGHT (not fixed) — `ZineAppBar` is 76/92dp of unscalable chrome

**File:** `app/lib/core/ui/zine_widgets.dart:963` — `Size.fromHeight(tag == null ? 76 : 92)`.
Scaffold adds `MediaQuery.padding.top` on top of that, so the band is ~100dp before any
content. `AD.searchDockTopGap` (`avatok_dark.dart:146`) then adds `28 * chromeScale +
seamClearance` below the wave.

On 393x590 that is **~17% of the viewport gone before the first row**, and `chromeScale` is
1.0 so RESP-SMALL-1's lever does nothing here. It is a constant, so it never overflows —
it just costs list rows. Hosts affected today: `inbox_list_screen.dart:491`,
`marketplace_browse.dart:165`.

### 7. TIGHT/CLIPS (not fixed) — chat thread: composer + emoji panel + banners vs a 590dp column

**Files:** `app/lib/features/avatok/chat_thread.dart:1377` (`Expanded` around the list),
`:1361-1370` (pin / save-contact / conference / catch-up banners),
`app/lib/features/messaging/widgets/rich_input_bar.dart:191-330`.

`RichInputBar` is a two-row band: toolbar `_barIcon` height 44 (:350) + field row with a
46x46 action slot (:302) ≈ **106dp**, plus `topSlot` (reply banner ≈ 50dp, listening banner,
compose preview) and, when open, `RichPickerPanel(height: _panelHeight)` where
`_panelHeight` defaults to **300** (:86).

At 393x590 with the picker open: header ~58 + panel 300 + composer 106 = 464, leaving ~126dp
of message list. At 320x480: 464 against 480 — the `Expanded` list collapses to ~16dp and any
banner in `topSlot` tips the `Column` into a `RenderFlex` overflow. Ugly and fragile, but the
list is `Expanded` so nothing becomes unreachable. Sane fix is capping `_panelHeight` at a
fraction of the viewport height; deferred as a behaviour change to a shared widget.

### 8. TIGHT (not fixed) — `AskAvaScreen._emptyState` does not scroll

**File:** `app/lib/features/askava/askava_screen.dart:421` — `Center(Padding(EdgeInsets.all(
Msg.s6), Column(mainAxisSize: min, …)))` with a 54dp badge, a title, a 3-sentence example
string and a "Start a chat" button.

Measured ≈ 319dp at 393x590 (available ≈ 485dp) and ≈ 299dp at 320x480 (available ≈ 375dp) —
it fits at the app's own bump on both. It clips only if the OS accessibility scale is pushed
well past the app's ceiling. Wrapping it in a scrollable would change the vertical centring
of a brand-new screen; left as documented debt.
The thread-screen twin at `:982` is smaller (no button) and safe.

### 9. TIGHT (not fixed) — `companion_thread` composer on a keyboard-open tiny screen

**File:** `app/lib/features/ava_companion/companion_thread.dart:886-970`. Two stacked rows
(36dp icon row + 48dp send button + paddings ≈ 110dp, up to ~170dp with a 4-line field) plus
a ~64dp header. At 320x480 with a soft keyboard the two inflexible children can just exceed
the remaining ~230dp and overflow. Structure is otherwise correct (`Column` → `Expanded`
list → composer, :578).

---

## Surfaces inspected and found FINE — do not re-check these

- **`app/lib/shell/ava_sidebar.dart` — logout is safe.** `_column` (:188) is
  `Column[header band, DoubleWaveSeam, profile card, plan chip, **Expanded(ListView)**,
  DoubleWaveSeam, footer band with Log out]` (:279, :381-401). Every variable-length thing is
  inside the `Expanded` list; Log out is pinned in the footer band and cannot be pushed off.
  Fixed chrome ≈ 330dp at 393x590 (list gets ~260) and ≈ 300dp at 320x480 (list gets ~180) —
  positive in both cases, so no `RenderFlex` overflow. The `[UI-CALLS-2026]` comment at :372
  claiming the wave used to ride over logout is now correct by construction.
- **`marketplace_browse.dart:169-300`.** `Column[search Padding, SizedBox(height: 44) chip
  strip, Divider, **Expanded(grid)**]`. ~141dp of fixed chrome; the grid, both empty states
  (:257, scrollable `ListView` — the old hard 120px spacer is gone) and the loading spinner
  all live in the `Expanded`. `SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent:
  240, childAspectRatio: 0.66)` gives 2 columns x ~270dp tiles at 393dp; tiles scroll.
  Keyboard-open at 320x480 leaves the grid ~33dp — tiny but it flexes, it does not overflow.
- **`inbox_list_screen.dart:463-499`.** `Column[AdSearchDock, _campaignFilterBar (fixed
  `height: 40`, :403, renders `SizedBox.shrink()` when there are no campaigns),
  **Expanded(_list)**]`. All three empty/error states (:520, :539, :565) are `ListView`s with
  a 100dp lead spacer, so they scroll. The `SizedBox(height: 100)` is inside the scrollable
  and costs nothing on a short screen.
- **`call_recording_card.dart`.** Card body (:380-560) is `maxLines`-bounded throughout and
  lives inside the inbox list. Its long-press sheet (:270) IS `isScrollControlled: true`; five
  ~52dp rows ≈ 300dp, comfortably inside 480dp. The `Spacer()` at :662 is inside a `Row`,
  not the `Column(min)` above it — not the bug it looks like.
- **`inbox_list_screen._showThreadMenu` (:825)** — `isScrollControlled: true`, four rows.
- **`askava_screen._sessionMenu` (:204)** — no `isScrollControlled`, but ~200dp of content
  against a 332dp cap at 393x590 and 270dp at 320x480. Fits.
- **`composer._pickTransLang` (:796)** and **`_openMentionPicker` (:1085)** — both already use
  `Flexible` over a `shrinkWrap` `ListView`; they scroll inside whatever cap applies.
  `_mentionBar` (:1213) is `BoxConstraints(maxHeight: 160)` over a scrolling `ListView`.
- **`call_screen._showDtmfPad` (:2640)** — not `isScrollControlled`, and 4 rows of ~107dp
  tiles ≈ 464dp exceeds the 332dp cap at 393x590 — **but** `GridView.count(shrinkWrap: true)`
  is a `ShrinkWrappingViewport`: it clamps to the incoming max and stays scrollable, so `*`,
  `0` and `#` are reachable. Not a bug.
- **`askava_screen` thread body (:960-978)** and **`companion_thread` body (:575-595)** —
  both `Column[Expanded(list), composer]`; correct shape.
- **`call_hero_composition.dart` geometry itself** — the medallion maths matches the assets
  (checked against both SVG viewBoxes above). Only its unbounded HEIGHT is a concern
  (finding 5).

---

## Proposed height helper for `app/lib/core/ui/breakpoints.dart` (NOT written — owner approval)

I do not own that file. The findings above justify a height input; here is the exact API I
would add, deliberately in the shape of the existing `xcompactMax`/`isXCompact` pair so it
needs no change to `ZineWidthClass` and therefore no exhaustive-switch churn:

```dart
/// [RESP-SMALL-3] The HEIGHT tier. Every threshold in this file keys off width,
/// which misses the BlackBerry-style QWERTY handset entirely: ~393dp wide (so
/// `regular`, `chromeScale` 1.0, full 1.22 type bump) but only ~590dp tall
/// because a hardware keyboard takes the bottom third of the chassis.
///
/// Reference points: 590dp = KEYone/KEY2 class; 480dp = the genuinely tiny
/// phone; 640dp is chosen as the "short" line because an ordinary modern
/// handset is 780-930dp and no mainstream phone sits between 660 and 780.
static const double shortMax = 640;
static const double xshortMax = 520;

static bool isShort(BuildContext context) =>
    MediaQuery.sizeOf(context).height < shortMax;

/// Fraction of the viewport a decorative hero may occupy. 1.0 on a normal
/// screen (nothing changes), 0.42 when short, 0.34 when very short.
static double heroHeightFraction(BuildContext context) {
  final h = MediaQuery.sizeOf(context).height;
  if (h < xshortMax) return 0.34;
  if (h < shortMax) return 0.42;
  return 1.0;
}

/// Chrome multiplier that takes the SMALLER of the width and height reliefs,
/// so a short-but-normal-width phone finally gets some. Same 1.0/0.85/0.72
/// ladder and the same scope rule as [chromeScale]: CHROME ONLY, never type,
/// never tap targets.
static double chromeScaleHV(BuildContext context) {
  final h = MediaQuery.sizeOf(context).height;
  final vertical = h < xshortMax ? 0.72 : (h < shortMax ? 0.85 : 1.0);
  return math.min(chromeScale(context), vertical);
}
```

**What it would fix:** finding 5 (clamp the hero to `heroHeightFraction` x viewport height —
the single biggest win, 350dp → ~248dp on the tester's phone), finding 6 (`ZineAppBar`
`preferredSize` x `chromeScaleHV`, 76 → ~65dp, floored so the 40dp back button still fits),
and finding 7 (cap `RichPickerPanel._panelHeight` at ~0.45 x viewport height).
It would NOT have fixed findings 1-4, which are structural, not dimensional — that is why
those were fixed directly rather than waiting on the helper.

**Do not** apply `chromeScaleHV` to type: `main.dart`'s builder already owns text scale
([RESP-SMALL-1]) and multiplying the two compounds into unreadable text, which is the exact
trap `breakpoints.dart:77-83` warns about.

---

## Needs the physical device to confirm

1. That the call header's back/minimize buttons now respond to a tap (finding 3) — the
   hit-test change cannot be proven by reading, only by pressing.
2. The exact height of the call header row on a real device with the status bar and the
   optional `_PeerStateLine` present, to confirm `_headerReserve`'s 72 is an over-estimate
   rather than an under-estimate.
3. Whether `RichPickerPanel`'s remembered `_panelHeight` on a phone with a HARDWARE keyboard
   is a sensible number at all — `PickerRecentsStore.I.keyboardHeight` learns from the soft
   keyboard, which this tester may rarely raise, leaving the 300dp default on a 590dp screen.
4. That the two bottom sheets now scroll rather than clip, with a wordy set of reply ideas.
