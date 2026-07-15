# Design brief — PSTN call screens (AvaDial)

**For:** the designer
**Date:** 2026-07-15
**Scope:** PSTN (real phone network) calls only. Not AvaTOK VoIP, not group conference.

---

## 1. The shape of the flow

A PSTN incoming call touches **two screens**, built in **two different technologies**:

```
  phone rings
      │
      ▼
┌─────────────────────┐
│  SCREEN A           │   Native Android (Kotlin)
│  Incoming / ringing │   Paints with the app closed, phone locked
└─────────────────────┘
      │ user taps Answer
      ▼
┌─────────────────────┐
│  SCREEN B           │   Flutter
│  In-call / active   │   App is now open
└─────────────────────┘
```

There is a **third screen in the codebase (`PstnCallScreen`) that is dead** — it never
appears. Ignore it. It is the old Flutter ringing screen, removed 2026-07-14. It is
listed here only so nobody designs for it by mistake.

### Why two technologies (this constrains the design)

Screen A must appear when the phone is **locked and the app is not running**. Booting
the Flutter engine to do that is too slow, and it used to fight with the landing page.
So Screen A is hand-drawn in Kotlin — no Flutter, no engine, instant paint.

**Practical consequence:** Screen A and Screen B cannot share a Hero animation, a shared
element transition, or any Flutter widget. They are separate processes. The transition
between them is an Android task switch. Design them as two screens that *look* continuous,
not as one screen that morphs.

---

## 2. CRITICAL — the palettes don't match today

Screen A and Screen B are currently different colour schemes. This is a bug, not a choice.
**The designer should specify ONE palette for both.**

| Token | Screen A (native) | Screen B (Flutter) |
|---|---|---|
| Background | `#141416` | `#0B0B0D` |
| Card / surface | `#1B1B1D` | surface2 |
| Stroke | `#2E2E31` | `#2C2C33` |
| Danger / red | `#D9534F` | `#E5735C` |
| Contact / green | `#11A37F` | `#6FCF97` |
| Unknown / blue | `#7BA7D9` | `#6FA8E8` |
| Answer orange | `#E8883A` | `#E8833A` (primaryBadge) |
| Text primary | `#FFFFFF` | white |
| Text soft | `#B5B5B8` | textSoft |

Both screens draw a **108×108dp avatar circle** in the same position. With mismatched
colours, answering a call visibly shifts the palette. Unifying these two columns is
probably the single highest-value change.

---

## 3. SCREEN A — Incoming / ringing (native Kotlin)

**File:** `app/android/app/src/main/kotlin/ai/avatok/avadial/IncomingCallActivity.kt`
**Built with:** programmatic Kotlin views (`LinearLayout` + `TextView` + `GradientDrawable`).
No XML layout file. No Flutter.

### What it does

Shows over the lock screen, turns the screen on, and lets the user Answer, Decline, Block,
or Report spam. Self-dismisses if the call is cancelled or picked up elsewhere.

### Three states, driven by spam score

The screen has exactly **three visual variants**. Score threshold is **70**.

| Variant | Condition | Accent | Glyph | Kicker text |
|---|---|---|---|---|
| **Spam** | score ≥ 70 | `#D9534F` red | `!` | `SUSPECTED SPAM` (in red) |
| **Contact** | not spam, name known | `#11A37F` green | `↙` | `INCOMING CALL` |
| **Unknown** | not spam, no name | `#7BA7D9` blue | `↙` | `UNKNOWN NUMBER` |

### Current layout, top to bottom

Scrollable column, padding `24 / 48 / 24 / 28`, centred.

1. **Flex space** (pushes content to centre)
2. **Avatar circle** — 108×108dp, filled with the accent colour, 2dp `#2E2E31` stroke.
   **Contains a text character, not an image**: `!` for spam, `↙` otherwise. 40sp, white, bold.
3. 20dp gap
4. **Kicker** — 13sp, bold, letter-spacing 0.12. Red for spam, `#B5B5B8` otherwise.
5. 6dp gap
6. **Name** — 30sp bold white. Falls back to the number, then to `"Unknown"`.
7. **Number sub-line** — 15sp soft grey. *Only shown if a name was resolved* (otherwise the
   name row already shows the number).
8. **Spam banner** — spam variant only. Card, `#1B1B1D` fill, 14dp radius, 1dp stroke,
   padding 14/12. Text: *"Reported by the community (score N). We recommend declining."*
9. **Flex space**
10. **Primary button row** — two pills side by side, 52dp tall, equal width, 12dp apart:
    - `Decline` — red fill, white text
    - `Answer` — orange fill. **When spam:** label becomes `Answer anyway` and the fill
      drops to neutral grey `#2A2A2D` (deliberately de-emphasised).
11. 12dp gap
12. **Secondary button row** — `Block` and `Report spam`, 48dp, neutral grey fill.

All buttons: 16sp bold, 26dp corner radius, 1dp stroke. They are `TextView`s with click
listeners — **so they have no Material ripple**. A tap gives no feedback at all.

### What the buttons actually do

- **Answer** → tells the OS to answer. **Nothing on screen changes.** The screen sits frozen
  until the OS confirms the call went active, then the activity finishes and Flutter opens.
  If nothing lands within 10s, the screen just stays there still ringing.
- **Decline** → rejects, cancels the notification, closes.
- **Block** → adds to the Android system block list, queues an in-app block, then declines.
- **Report spam** → same as Block, plus flags it as spam for the community score.

### 🔴 The biggest UX gap on this screen

**Answer has zero feedback.** User taps, nothing happens, then a beat later the whole screen
swaps. This is the most important thing to design. See §6.

---

## 4. SCREEN B — In-call / active (Flutter)

**File:** `app/lib/features/avadial/in_call_screen.dart`

### What it does

Shows the live call: who you're talking to, how long it's been, and the controls.

### Layout, top to bottom

Same shell — padding `24 / 32 / 24 / 28`, centred column.

1. **Flex space**
2. **Avatar circle** — 108×108dp. Green `#6FCF97` if the caller is a saved contact, blue
   `#6FA8E8` if not. **Contains the contact's first initial, uppercased** (44sp) — or a
   phone icon if there's no name. Again, no photo.
3. 20dp gap
4. **Name** — 30sp bold. Falls back to the number.
5. 6dp gap
6. **Status line** — 16sp soft grey. One of:
   - `Dialing…`
   - `Ringing…`
   - `On hold`
   - **the timer** — `mm:ss`, or `h:mm:ss` past an hour. Ticks every second.
7. **Flex space**
8. **Controls row** — three circular buttons, evenly spaced. 18dp padding, 26dp icon,
   6dp gap to an 11sp label underneath:
   - **Mute** — mic / mic-slash. When on, fills orange `#E8833A`.
   - **Keypad** — opens the DTMF grid. Never shows an "on" state.
   - **Speaker** — speaker icon. When on, fills orange.
9. 18dp gap
10. **End button** — full-width red pill.

### Keypad mode

Tapping Keypad **replaces the controls row** (not an overlay) with a 3-column grid:
`1-9`, `*`, `0`, `#`. Each key is a rounded rect, 16dp radius, digit at 26sp. A ghost
`Hide keypad` button sits below. The End button stays put.

### Known gaps on this screen

- **No hold button.** `On hold` can display as a status but the user can't trigger it.
- **Bluetooth/headset are invisible.** Audio routing only reports "speaker on/off", so a
  bluetooth call renders identically to earpiece.
- **No photo**, only an initial.

---

## 5. What data you can actually put on screen

This is the part that decides what's designable. **Everything below is a local read that
works with the app closed and the phone locked** — except where noted.

### Available today (already passed to Screen A)

| Data | Notes |
|---|---|
| Phone number | Always, unless withheld |
| Contact name | Needs contacts permission. Null if not granted or not saved. |
| Spam score `0-100` | Only if the number is in the local snapshot. Often absent. |
| Spam bucket | `red` / `reported` / `unknown` |

### Available with a small code change — NOT currently used

These all exist in the codebase and are readable natively with no Flutter engine. The
missed-call overlay already does exactly this, so the precedent is proven.

| Data | Where it lives | Design opportunity |
|---|---|---|
| **Contact photo** | `Phone.PHOTO_URI` — one extra column on the query already being run | Real avatar instead of a glyph |
| **Is an AvaTOK user** | `filesDir/avadial/avatok_directory.json`, already on disk | AvaTOK badge — "this person is on AvaTOK" |
| **AvaTOK avatar URL** | Same file | Avatar even for non-saved contacts (needs a network fetch — will pop in late) |
| **Call history** | Android `CallLog`, permission already granted | "3rd call today", "you missed them twice", "last spoke 2 weeks ago" |
| **Ring duration** | Computed elsewhere already | — |
| **Block-list status** | System block list + in-app | "You blocked this number" |

**Recommendation:** the contact photo and the AvaTOK badge are cheap and high-impact. The
avatar circle is currently the biggest element on both screens and it's showing an arrow
character.

### Known data bugs worth flagging

- Screen A **hardcodes the spam threshold at 70** instead of reading the configured value
  from the snapshot. If the threshold is ever tuned server-side, the ring screen ignores it.
- The `"reported"` bucket (a real but sub-70 score) gets **no visual treatment at all** —
  a number scored 69 looks like a normal call.
- The spam score frequently won't be there. **Design the no-score case as the default**,
  not the exception.

---

## 6. Animation brief

**There is currently no animation on either screen. None. This is greenfield.**

Confirmed: no `AnimationController`, no `AnimatedContainer`, no `Hero`, no implicit
animations. The avatar glow is explicitly disabled in code (`boxShadow: const <BoxShadow>[]`)
on both screens. Screen A's buttons don't even have a press ripple.

### Priority 1 — Answer feedback (the real problem)

Tapping Answer currently does nothing visible for an unpredictable gap (typically short,
but up to 10 seconds on a bad network). Then the screen hard-swaps.

**Needs:** an immediate state on tap — button collapses to a spinner, or the avatar
transitions, or the buttons fade out and the status line changes to "Connecting…". Anything
that acknowledges the tap within one frame. This must be designed **on the native screen**,
because the swap to Flutter happens *after* the OS confirms.

### Priority 2 — Ringing life

The ring screen is a completely static frame. A ringing phone should feel alive.

**Ideas:** pulsing ring/halo around the avatar (this is the classic, and the 108dp circle
is built for it), a subtle breathing scale, an entrance animation as the screen appears.
Keep it cheap — this runs on a locked phone, possibly on a cold CPU.

### Priority 3 — The seam

Ring → in-call is an Android task switch, then possibly a Flutter engine boot, then a
bottom-up slide. It is not smooth and **it cannot be made into a shared-element transition.**

**Mitigation is compositional, not technical:** if both screens put the same avatar at the
same 108dp size in the same position with the same colour, the seam reads as a crossfade
rather than a jump. This is why §2 (unified palette) matters so much.

### Priority 4 — Button press states

Screen A's buttons have no ripple, no press state, nothing. Specify a press treatment.

### Priority 5 — Nice to have

- Timer tick — currently a raw text swap every second. Could be subtler.
- Mute/speaker toggle — currently an instant colour snap.
- Keypad open/close — currently an instant swap of the controls row.
- Spam banner entrance.

### Animation constraints to respect

- **Screen A is Kotlin.** Animations must be Android view animations, not Flutter. Anything
  the designer specs for the ring screen gets built twice if it's also on the in-call screen.
- **Screen A runs on a locked, cold device.** Budget accordingly. No heavy work on first frame.
- **No shared elements across the seam.** Different processes. Period.
- **Screen A has no XML layout.** Every view is constructed in code. Complex layouts are
  more expensive to build here than in Flutter — keep the ring screen's structure simple.

---

## 7. Summary for the designer

**Design two screens:**

**A. Incoming / ringing** — 3 variants (spam / known contact / unknown number). Over the lock
screen. Answer, Decline, Block, Report spam. Must feel alive while ringing and must
acknowledge the Answer tap instantly.

**B. In-call / active** — name, avatar, live timer, mute / keypad / speaker, end. Plus a
keypad mode that replaces the controls.

**Do three things above all:**

1. **Unify the palette** across both — they're currently different products.
2. **Fix the Answer moment** — the dead gap on tap is the worst part of the flow.
3. **Use the avatar circle properly** — it's the biggest element on both screens and it's
   currently rendering an arrow character. Photo + AvaTOK badge are both available.

**Don't design:** `PstnCallScreen`. It's dead code.

---

## 8. File map

| Screen | File |
|---|---|
| A — ringing (LIVE) | `app/android/app/src/main/kotlin/ai/avatok/avadial/IncomingCallActivity.kt` |
| B — in-call (LIVE) | `app/lib/features/avadial/in_call_screen.dart` |
| ~~Old ringing (DEAD)~~ | ~~`app/lib/features/avadial/pstn_call_screen.dart`~~ |
| Spam scoring | `app/android/app/src/main/kotlin/ai/avatok/avadial/AvaCallScreeningService.kt` |
| Call plumbing | `app/android/app/src/main/kotlin/ai/avatok/avadial/AvaInCallService.kt` |
| Answer → Flutter handoff | `app/lib/shell/shell_v2.dart` (`_openIncoming`, ~line 308) |
