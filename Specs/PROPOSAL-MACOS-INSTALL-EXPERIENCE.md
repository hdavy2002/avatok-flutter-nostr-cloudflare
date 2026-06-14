# Proposal — AvaTok macOS Install Experience (Unsigned .dmg + In-App Onboarding)

**Date:** 2026-06-14
**Status:** Assets drafted, ready to wire (build step requires a Mac)
**Decision taken:** Distribution = **direct-download, unsigned `.dmg`** for testing. Install UX = **Styled DMG + in-app first-run onboarding** (no installer wizard).
**Companion docs:** `PROPOSAL-MACOS-DESKTOP-DMG.md` (full conversion plan).

---

## 1. The two pieces of the "install pipeline"

On macOS a `.dmg` is **not** a multi-step wizard — it's a single drag-to-Applications window. So the "beautiful install" is delivered in two stages:

1. **Styled DMG window** — branded background, a coral drag-arrow from the AvaTok icon to the Applications folder, custom window size and icon placement, and a first-launch Gatekeeper hint (because the build is unsigned).
2. **In-app first-run onboarding** — a 4-panel welcome sequence shown **once** the first time the installed app launches. This is where modern Mac apps put their "pretty pipeline," and it's fully in your Zine design language.

Everything else stays the same — same codebase, same features, same backend.

---

## 2. What's already produced (in `packaging/macos-dmg/`)

```
packaging/macos-dmg/
├── assets/
│   ├── dmg-background.png      # 660×420 zine-styled DMG window background
│   └── dmg-background@2x.png   # retina (1320×840) — Finder auto-uses it
├── build-dmg.sh                # one-command unsigned styled-DMG builder
└── reference/
    └── mac_first_run.dart      # drop-in 4-panel first-run onboarding
```

- **`dmg-background.png`** — paper surface, inked frame, hard offset shadows (no gradients), blue title sticker "Drag AvaTok into Applications", coral arrow, AvaTok wordmark (teal "TOK"), and a mono hint pill "First launch: right-click AvaTok → Open". The two empty pads are where Finder overlays the real app icon (left) and the Applications alias (right).
- **`build-dmg.sh`** — runs `flutter build macos --release`, renames the product to `AvaTok.app`, strips quarantine, applies an ad-hoc (unsigned) signature, then calls `create-dmg` with the background + icon layout. Output: `packaging/macos-dmg/dist/AvaTok.dmg`.
- **`reference/mac_first_run.dart`** — the onboarding (see §4). Lives in `reference/` so it doesn't enter the build until you move it into `lib/`.

---

## 3. Building the DMG (run on a Mac)

```bash
# one-time
flutter config --enable-macos-desktop
brew install create-dmg
cd app && flutter create --org ai.avatok --platforms=macos .   # generates macos/

# every build
bash packaging/macos-dmg/build-dmg.sh
open packaging/macos-dmg/dist/AvaTok.dmg
```

Because it's **unsigned**, the very first launch on any Mac needs **right-click → Open** once (or `xattr -dr com.apple.quarantine /Applications/AvaTok.app`). After that it opens normally. This is expected and fine for your own testing; signing/notarization (the Apple Developer account) is only needed to remove that step for other people — see the companion doc.

> The `.app` product name: the script assumes the build output is `avatok_call.app` (from `pubspec` `name: avatok_call`). If you rename the product in Xcode, update `BUILT_APP` in the script.

---

## 4. In-app first-run onboarding

**Four panels**, built only from your existing Zine widgets (`ZinePaper`, `ZineButton`, `ZineCard`, `ZineSticker`, `ZineCrest`, `ZineStepPips`, `ZineIconBadge`, `ZineMarkTitle`, `ZineText`, `Zine.*`):

1. **Welcome** — crest + "AvaTOK for Mac" + marker-highlighted "Your whole world, now on the **big** screen."
2. **Features** — 2×2 card grid: Chat & calls, Marketplace, Storage, Wallet.
3. **Permissions** — explains the macOS mic/camera/notification prompts (set expectations; macOS asks on first use).
4. **Ready** — confetti badge + "You're all **set**" + sticker, CTA "Open AvaTok".

Bottom: full-width CTA + step pips + back button. Content is held in a **560px max-width centered column** so it looks composed in a large desktop window rather than stretched.

**Wiring (3 steps):**

1. Move `reference/mac_first_run.dart` → `app/lib/features/onboarding/mac_first_run.dart`.
2. Replace the in-memory `seen()/markSeen()` stub with persistence. Recommended **device-level** (this is a per-install welcome, not per-account state) via `flutter_secure_storage` with a global key. If you prefer per-account, use `scopedKey('mac_first_run_seen')` per the CLAUDE.md scoping rule.
3. In `main.dart`, after init and before the shell, macOS-gated:

```dart
if (Platform.isMacOS && !await MacFirstRun.seen()) {
  await Navigator.push(context, MaterialPageRoute(
      builder: (_) => MacFirstRun(onDone: () => Navigator.pop(context))));
  await MacFirstRun.markSeen();
}
```

This is **additive and macOS-only** — the existing mobile `WelcomeScreen` / `onboarding_flow` are untouched.

> The reference file uses the documented Zine widget vocabulary; a couple of constructor parameter names (e.g. `ZineStepPips`, `ZineIconBadge`, `ZineBackButton`) should be checked against their actual signatures in `core/ui/zine_widgets.dart` when you move it into `lib/` — adjust if the analyzer flags them. Per project memory, the APK builds in CI on push, so the analyzer/build runs there.

---

## 5. macOS Info.plist usage strings (needed for the permission prompts)

Add to `macos/Runner/Info.plist` so the prompts in panel 3 actually appear (otherwise macOS kills the app on first camera/mic access):

```xml
<key>NSCameraUsageDescription</key>
<string>AvaTok uses the camera for video calls.</string>
<key>NSMicrophoneUsageDescription</key>
<string>AvaTok uses the microphone for calls and voice notes.</string>
```

And the matching entitlements in `macos/Runner/Release.entitlements` (see companion doc §4): network client, camera, audio-input, user-selected files.

---

## 6. Status & next step

| Item | State |
|---|---|
| DMG background artwork (@1x + @2x) | ✅ done |
| Unsigned styled-DMG build script | ✅ done |
| In-app 4-panel onboarding (reference) | ✅ done |
| `macos/` target generated | ⬜ needs `flutter create` on a Mac |
| Plugin guards (callkit/contacts/camera) | ⬜ (companion doc §4) |
| First build of `AvaTok.dmg` | ⬜ run `build-dmg.sh` on a Mac |

**Next step:** on your Mac, run the three one-time commands in §3, then `build-dmg.sh`. If you want, I can prepare the plugin guards and the `main.dart` wiring as a ready-to-commit patch so the first build is genuinely one command.
