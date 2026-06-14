# Proposal — AvaTok macOS Desktop App (Direct-Download .dmg, test build)

**Date:** 2026-06-14
**Author:** prepared for davy
**Status:** Proposal / not started
**Distribution target (this round):** Direct download `.dmg` — signed with **Apple Developer ID** + **notarized**. *Not* the Mac App Store (separate future track).
**Guiding rule:** keep **everything the same** — same single Flutter codebase, same Cloudflare-native backend, same features, same business logic, same money rules. The only product-visible change is that the **UI expands to fill a Mac window** instead of staying phone-width.

---

## 1. Goal & non-goals

**Goal.** Ship a native macOS build of the existing Flutter app (`app/`) as a downloadable, double-click-installable `.dmg` that a user can run on their Mac without the App Store, with a layout that uses the larger screen properly.

**Non-goals (this round).**
- No Mac App Store submission, no sandbox-store entitlements review.
- No iOS target (still absent; out of scope here).
- No feature redesign — screens and flows stay identical; only the *layout shell* adapts.
- No backend changes — the Worker / DO / D1 / R2 stack is untouched.

---

## 2. Where the project stands today

- **One platform target.** `app/` has `android/` only — no `macos/` (or `ios/`) folder yet. macOS must be generated.
- **Architecture is desktop-friendly.** The signed-in shell (`lib/shell/ava_shell.dart`) is a `Scaffold` with a **drawer sidebar** (`ava_sidebar.dart`, 82% screen width) and a single `body`. Every app (AvaTok, AvaLive, Wallet, etc.) opens via a full-screen `Navigator.push`. This is a textbook phone pattern — and converts cleanly to a desktop "permanent sidebar + content pane" layout.
- **Most plugins already support macOS.** Confirmed from the lockfile: `flutter_webrtc`, `livekit_client`, Firebase (core/auth/messaging), `drift` + `sqlite3_flutter_libs`, `flutter_secure_storage`, `audioplayers`, `record`, `video_player`, `image_picker`, `file_picker`, `path_provider`, `geolocator`, `url_launcher`, `share_plus`, `posthog_flutter`, `app_badge_plus`, `flutter_local_notifications`, plus all pure-Dart packages (`drift`, `pointycastle`, `bip340`, `cryptography`, `qr_flutter`, `phosphor_flutter`, `flutter_chat_ui`).
- **Plugin gaps are few and isolated** (see §4). This is the single most important finding: the phone-only code lives in just a handful of files, so guarding it is low-risk.

---

## 3. High-level approach

Four work streams, sequenced to de-risk early:

1. **Spike** — generate the `macos/` target, compile, capture what breaks. (½–1 day)
2. **Platform enablement** — patch the gap plugins, entitlements, push, signing. (2–4 days)
3. **Responsive shell** — sidebar-becomes-permanent + master/detail panes. (bulk of the UI time, 5–8 days)
4. **Packaging & distribution** — Developer ID sign → notarize → staple → `.dmg`, wired into CI. (1–2 days)

Total rough estimate: **~2–3 weeks** of focused work for a polished test build; a *bootable* spike is achievable in a day.

---

## 4. Platform enablement — the plugin gaps

Generate the target:

```
cd app
flutter create --org ai.avatok --platforms=macos .
```

Then handle the four areas where a phone plugin has no macOS implementation. Each is isolated to 1–2 files, so the pattern is: **platform-guard with `Platform.isMacOS` / `kIsWeb` checks and provide a desktop fallback.**

| Area | File(s) | macOS status | Recommended handling for the .dmg test |
|---|---|---|---|
| **Native incoming-call UI** (`flutter_callkit_incoming`) | `features/avatok/call_screen.dart`, `push/push_service.dart` | No macOS support | Gate CallKit behind `Platform.isAndroid/isIOS`. On macOS show an **in-app incoming-call banner + local notification** (you already depend on `flutter_local_notifications`, which supports macOS). 1:1 P2P call itself still works (WebRTC is supported). |
| **Device contacts** (`flutter_contacts`) | `core/device_contacts.dart` | No macOS support | Guard the import; on macOS return an empty list and **hide the "invite from contacts" entry point**, or offer manual/handle-based invite. Single-file change. |
| **Liveness camera** (`camera`) | `features/identity/liveness_check_screen.dart` | Not supported by the core `camera` plugin on macOS | For the test build, **disable L2 liveness on macOS** (show "complete this step on your phone") *or* later swap to `camera_macos`. Don't block the build on this. |
| **Permissions** (`permission_handler`) | various | Limited on macOS | macOS grants camera/mic/network via **Info.plist usage strings + App entitlements**, not runtime prompts. Add the usage-description keys; treat `permission_handler` calls as no-ops where macOS handles it natively. |
| **Live-translate PCM** (`flutter_pcm_sound`) | `features/translation/translation_engine.dart` | Verify in spike | Likely fine on macOS; confirm during the spike and guard if not. |

**macOS entitlements** (for `macos/Runner/*.entitlements`) needed for the feature set:
- `com.apple.security.network.client` (and `.server` if any local listener) — Worker/WebSocket/WebRTC.
- `com.apple.security.device.camera` and `com.apple.security.device.audio-input` — calls, voice notes, liveness.
- `com.apple.security.files.user-selected.read-write` — `file_picker` / media.
- `com.apple.security.personal-information.location` — only if location share is kept on Mac.

> Note: for **direct-download (Developer ID)** you can run with the **hardened runtime** but *without* the full App Store sandbox, which simplifies file/network access for the test. Hardened runtime is required for notarization.

**Push on macOS.** Firebase Cloud Messaging on macOS rides **APNs**, which differs from Android FCM. For the test `.dmg` you may **defer push entirely** (gate `PushService.init()` to mobile) and rely on in-app polling/WebSocket while the app is open — this removes the APNs-key setup from the critical path. Add APNs later if Mac push is wanted.

---

## 5. Responsive UI expansion (keep everything, just let it breathe)

The principle: **no screen is removed or redesigned** — the navigation *shell* adapts, and content columns get a sensible max width. Introduce one breakpoint helper and apply it in three places.

**Breakpoints.**
- `< 700px` → phone layout (unchanged — drawer sidebar, full-screen push).
- `≥ 700px` (Mac window default) → desktop layout.

**Change 1 — Sidebar becomes permanent.** Today `ava_shell.dart` keeps `AvaSidebar` in `Scaffold.drawer` (hidden, swipe/tap to open). On desktop, render it as a **fixed left column in a `Row`** instead of a drawer. `ava_sidebar.dart` already uses `MediaQuery` width math (the 82% line) — swap that for a fixed rail width (e.g. 260–300px) when desktop.

**Change 2 — Push becomes pane-swap (master/detail).** The `_openDest` switch currently does `Navigator.push(... MaterialPageRoute ...)` for every app. On desktop, instead of pushing a new full-screen route, **render the selected app into the content pane** of the shell `Row`. Mechanically: keep a `_current` destination (already exists) and build the right widget into the body rather than pushing. This makes app-switching instant and keeps the sidebar visible — exactly the desktop messaging-app feel.

**Change 3 — Two-pane inside list-heavy features.** For AvaTok chat (`chat_list.dart` → `chat_thread.dart`), AvaInbox, and AvaLibrary, show **list + detail side-by-side** on wide windows (list on the left of the content pane, open item on the right) instead of list-then-push. These screens already exist; this wraps them in a `LayoutBuilder` master/detail.

**Change 4 — Content max-width.** Single-column feeds (Explore, Wallet, Settings, Profile/Identity) get a **centered max-width container (~720–900px)** so they don't stretch edge-to-edge on a wide monitor. Grids (listings, library) can use more columns as width grows.

**Window chrome.** Set a sensible **minimum window size** (e.g. 900×640) and default size in `macos/Runner/MainFlutterWindow.swift`; optionally add a native **menu bar** and a few **keyboard shortcuts** (⌘, for Settings, ⌘W, etc.) as polish.

> All of the above is shell/layout work done **once**; individual feature widgets are reused as-is. This is why "keep everything the same" is realistic.

---

## 6. Build, sign, notarize, package (the .dmg pipeline)

**Prerequisites (one-time).**
- Apple Developer Program membership (you have one for Play? note: Apple is separate — $99/yr).
- A **Developer ID Application** certificate (for signing the app outside the store).
- An **app-specific password** or App Store Connect API key for `notarytool`.

**Local pipeline.**

```bash
# 1. Build release
cd app
flutter build macos --release
#    → build/macos/Build/Products/Release/avatok_call.app

# 2. Sign with Developer ID + hardened runtime (required for notarization)
codesign --deep --force --options runtime \
  --sign "Developer ID Application: <Your Name> (<TEAMID>)" \
  build/macos/Build/Products/Release/avatok_call.app

# 3. Package into a .dmg (create-dmg gives a nice drag-to-Applications layout)
create-dmg --volname "AvaTok" --app-drop-link 450 180 \
  AvaTok.dmg build/macos/Build/Products/Release/avatok_call.app

# 4. Notarize the .dmg and staple the ticket
xcrun notarytool submit AvaTok.dmg --apple-id <id> --team-id <TEAMID> \
  --password <app-specific-pw> --wait
xcrun stapler staple AvaTok.dmg
```

Result: a **`AvaTok.dmg`** that opens cleanly (no "unidentified developer" Gatekeeper block) and installs by dragging to Applications.

**CI option.** Your APK already builds via GitHub Actions. macOS builds **require a macOS runner** (`macos-latest`). Signing/notarization secrets (cert `.p12`, password, notary credentials) go in GitHub Secrets. This can be a follow-up; the first test `.dmg` is easiest to cut locally on a Mac.

**Hosting the download.** Since the rest of the stack is Cloudflare, the `.dmg` can be served from **R2 + a Pages/Worker download link** on avatok.ai (e.g. `avatok.ai/download/mac`), matching your existing infra. Optionally add a Sparkle-style auto-update feed later.

---

## 7. Phased plan & deliverables

| Phase | Work | Deliverable | Est. |
|---|---|---|---|
| **0. Spike** | `flutter create --platforms=macos`; compile; record breakages | A booting (if rough) Mac build + a concrete gap list | ½–1 day |
| **1. Plugin/platform fixes** | Guard callkit/contacts/camera; entitlements + Info.plist; gate push | Clean release build, all features either work or gracefully degrade on Mac | 2–4 days |
| **2. Responsive shell** | Permanent sidebar; pane-swap nav; master/detail in chat/inbox/library; max-width feeds; window min-size | Desktop-native layout, no feature loss | 5–8 days |
| **3. Polish** | Menu bar, keyboard shortcuts, window state, trackpad scrolling, icon/branding | Feels like a real Mac app | 1–2 days |
| **4. Package & ship** | Developer ID sign → notarize → staple → `.dmg`; host on R2; download page | Distributable `AvaTok.dmg` + download link | 1–2 days |
| **5. Verify** | Smoke-test every feature module on Mac; focus on calls, media, translation, wallet; check per-account scoping still holds | QA pass / sign-off | 1 day |

---

## 8. Risks & mitigations

- **WebRTC/LiveKit on macOS** — both declare macOS support, but calls are the highest-risk path. *Mitigation:* test 1:1 P2P and a small conference early in Phase 1; the incoming-call *UI* is replaced (CallKit→banner) but the media path is the same.
- **Camera/liveness gap** — *Mitigation:* disable L2 liveness on Mac for the test; revisit with `camera_macos` if Mac onboarding matters.
- **Notarization friction** — first notarization often fails on a missing hardened-runtime flag or an unsigned nested binary. *Mitigation:* `--deep --options runtime`, then read `notarytool log` for the exact offending file.
- **Per-account scoping (CLAUDE.md rule #1)** — the shared-device model still applies; macOS uses the same `scopedKey`/`AccountScope` code, but verify `flutter_secure_storage_macos` writes to the right keychain scope. *Mitigation:* explicit check in Phase 5.
- **Apple Developer account** — if not already enrolled, the $99/yr enrollment can take a day to approve. *Mitigation:* start enrollment now if needed.

---

## 9. Open decisions for you

1. **L2 liveness on Mac** — disable for the test (fast) or invest in `camera_macos` (slower but complete)?
2. **Push on Mac** — defer (poll while open) for the test, or set up APNs now?
3. **Where to host the .dmg** — R2 + a `avatok.ai/download/mac` page, or just hand you the file for now?
4. **Apple Developer enrollment** — already have it, or should that be step zero?

---

## 10. Recommended next step

Run **Phase 0 (the spike)**: generate the `macos/` target and attempt a release build, so we get a concrete, file-by-file compile/crash report instead of estimates. That single step turns this proposal into a precise task list and de-risks the rest. (Note: the actual `flutter build macos` must run on a Mac — I can prepare every code change, the entitlements, the guards, and the build/notarize scripts so it's a one-command run on your machine.)
