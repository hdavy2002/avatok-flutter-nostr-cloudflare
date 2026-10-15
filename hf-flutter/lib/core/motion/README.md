# Motion kit (HF-MOTION-1)

Shared animation pieces for every screen. Import `core/widgets/widgets.dart` (it re-exports the kit) or
`core/motion/motion.dart`. Colours come from the theme tokens: `HfColors.sunshine`, `HfColors.deepOrange`,
`HfGradients.sun` (sunshine to orange, top to bottom), `HfGradients.sunDeep` (orange to deep orange, left to
right) and `HfConfetti.palette` (primary, sunshine, blush, lavender).

## The reduced-motion rule

When the phone has "Remove animations" on (`MediaQuery.disableAnimationsOf`), every widget here shows its
FINAL state at once: no decorative movement, nothing stays hidden, all text is readable straight away. The
helper is `hfReduceMotion(context)` (built on `HfMotion.of`). Follow the same rule in anything you build on top.

## Performance rules (cheap Android phones)

- Only ONE animated beaver on screen at a time.
- Painters already sit behind a `RepaintBoundary`; do not stack many looping widgets in one list.
- Every widget disposes its own controllers. A `ConfettiController` you create is yours to dispose.
- Looping widgets (`Breathing`, `PulseDot`, `RippleRings`, `HfLoader`, `HfLottie(repeat: true)`) never settle:
  in widget tests use `tester.pump(duration)` instead of `pumpAndSettle`, or turn on reduced motion.

## Widgets

**BeaverGuide** - the onboarding mascot (a 3D beaver in a mustard kurta and orange Nehru jacket).
`BeaverGuide({pose = BeaverPose.idle, size = 160, message, bubbleSide = BeaverBubbleSide.above,
entrance = true, semanticLabel})`. Plays `assets/beaver/beaver_<pose>.webp` (looping, transparent);
with reduced motion shows `beaver_<pose>_still.png`. Changing `pose` cross-fades in 250 ms. On first
appearance it pops (scale 0.6 to 1 with a slight overshoot, 450 ms; `entrance: false` turns this off).
`message` appears in a `SpeechBubble` above it (or beside it, tail pointing left) and types word by word.
Screen readers hear "Hello Fraands beaver" (the brand name comes from `Brand.name`).
Poses: `idle, wave, happy, nod, phoneTalk, phoneLaugh, thumbs, point, namaste, celebrate, sleepy, oops`.
Call `precacheBeaver(context, pose)` before you show a new pose so the first frame is not blank.

**SpeechBubble** - `SpeechBubble({required text, tail = SpeechBubbleTail.bottom, animateWords = true,
wordInterval = 35 ms, style})`. White card, radius 18, soft shadow, small tail (`bottom`, `left` or `none`),
Nunito 15/600 ink text (`HfText.bubble`). Words appear one by one; the bubble is sized for the full message
from the start so nothing jumps. A new `text` types again. Reduced motion: full text at once.

**PopIn** - `PopIn({required child, delay = 0, duration = 320 ms, beginScale = 0.85, curve = easeOutBack,
alignment = center})`. Scale + fade in when first shown.

**StaggeredReveal** - `StaggeredReveal({required children, stagger = 60 ms, itemDuration = 280 ms,
delay = 0, rise = 12, spacing = 0, crossAxisAlignment = stretch, mainAxisSize = min})`. A Column whose
children fade in and rise 12 px one after another.

**Breathing** - `Breathing({required child, period = 2.4 s, maxScale = 1.03, enabled = true})`. Slow
1 to 1.03 scale loop (splash logo, call button).

**PulseDot** - `PulseDot({color = HfColors.roseDot, size = 10, period = 1.4 s, semanticLabel})`. An
"online now" dot with a heartbeat halo. The widget is 2.4 times `size` wide to fit the halo.

**RippleRings** - `RippleRings({required child, size = 240, ringCount = 3, period = 2.4 s,
colors = [primary, sunshine], enabled = true})`. Expanding, fading rings around `child` (calling screen).

**HfLoader** - `HfLoader({dotSize = 10, semanticLabel = 'Loading'})`. Three bouncing dots (primary,
sunshine, deep orange). Use it instead of a plain spinner in new work; existing spinners were not changed.

**CountUpText** - `CountUpText({required value, required formatter, from, style, textAlign,
duration = 700 ms, curve = easeOutCubic})`. Counts from the old value to the new one. `formatter` is a
`String Function(num)`: for money pass the existing formatter, e.g. `(v) => Money.paise(v.round())`. Never
compute money on the phone; only animate the display of a value the API returned. Whole-number values stay
whole while counting. With `from` it also counts on first build. Screen readers hear only the final value.

**ConfettiBurst + ConfettiController** - wrap an area:
`ConfettiBurst({required controller, required child, particleCount = 50, duration = 1.4 s,
origin = Alignment(0, -0.2), power = 1, colors = HfConfetti.palette})`, then call `controller.fire()`.
40 to 60 rounded rectangles and circles fly out, spin, fall and fade; fire-and-forget, never blocks taps.
Draws nothing with reduced motion.

**SunHill** - `SunHill({riseTo = 0.32, riseFrom, duration = 900 ms, curve = easeOutCubic, background, child})`.
Background with a cream sky and an orange hill (HfGradients.sun) with a soft yellow glow rim. `riseTo` is the
hill height as a fraction of the screen; changing it animates (splash breath, call-connected fill). Pass
`riseFrom` to animate on first build. `SunHillPainter(rise:, sky:)` is public if you need the hill in your own
painter.

**RibbonSweep** - `RibbonSweep({thickness = 56, duration = 900 ms, stay = true, onComplete, child})`.
A thick orange-to-deep-orange curved ribbon sweeps across once ("Nice work" style), `child` centred on top.
`stay: false` lets the ribbon leave. Needs a bounded size (e.g. `Positioned.fill`).

**DrawnCheck** - `DrawnCheck({size = 88, color = HfColors.primary, checkColor = HfColors.white,
duration = 650 ms, delay = 0, confetti = false, semanticLabel = 'Done'})`. A circle pops in and a tick draws
itself; `confetti: true` adds a small puff at the end.

**HfLottie** - `HfLottie(asset, {width, height, fit = contain, repeat = false, semanticLabel, onFinished})`.
Plays a bundled Lottie file; with reduced motion it shows the last frame and does not animate. Files:
`HfLottieAssets.sparkleBurst`, `.heartPop`, `.checkDraw` (made by `tool/gen_lottie.py`; edit the script and
re-run it, never the JSON by hand).

**HfBrandMark** (in `core/widgets/`) - `HfBrandMark({size = 96, showWordmark = false, wordmarkStyle})`.
The 3D sticker logo (`kLogoAsset`, currently `assets/brand/logo2.png`; the owner has not chosen between
logo1 and logo2, so switching is that one constant) with an optional Comfortaa wordmark (`HfText.wordmark`).
It does not change the launcher icon or `brand.dart`.

## Fonts

Nunito is the app font everywhere (`HfText.bodyFamily` and `displayFamily`). Comfortaa is only for the
brand wordmark (`HfText.wordmark`). The 14 sp minimum still applies.
