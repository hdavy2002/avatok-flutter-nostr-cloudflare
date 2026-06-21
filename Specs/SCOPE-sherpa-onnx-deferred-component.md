# SCOPE — Defer the sherpa-onnx voice runtime out of the base install

**Status:** Proposal / not started · **Author:** Cowork session 2026-06-22 · **Owner decision needed before build**

## 1. Goal & payoff

Keep the on-device voice native runtime (`libonnxruntime.so` + `libsherpa-onnx-*.so`,
**~15–25 MB arm64** — measure from the real build) **out of the base APK/AAB** so users
who never turn on Ava Voice don't carry it. Voice is already a manual, post-launch opt-in
(`Settings → Ava voice → enable` → `VoiceFeature.I.enable()`), and the models already
download on demand — so the runtime is the only voice payload still shipped at install.

**Who benefits:** the (likely majority at launch) users who never enable voice get a
smaller initial download. Users who enable voice pay the ~15–25 MB once, alongside the
~130 MB model download they already accept.

## 2. Why this is non-trivial (the constraints that drive the design)

1. **It's loaded by Dart FFI, not a method channel.** `sherpa_voice_engine.dart:55`
   calls `so.initBindings()`, which `DynamicLibrary.open(...)`s the `.so` by name. The lib
   must be on the loader's native search path **before** that first call. After a dynamic
   feature module installs, its native libs are only added to that path if `SplitCompat`
   is active — so the app must `SplitCompat.install(...)` (or extend
   `FlutterPlayStoreSplitApplication`).
2. **sherpa_onnx is a normal pub dependency**, so the Flutter Gradle plugin places its
   native libs in the **base** module by default. A plain `deferred-components:` block in
   `pubspec.yaml` defers Dart AOT split units + **assets**, but does **not** cleanly move a
   third-party plugin's `.so` into a feature module. Moving the libs requires either
   restructuring sherpa as a feature-module dependency or a manual DFM (see §3).
3. **On-demand delivery only works through Play (AAB) — and AAB shipping is currently OFF.**
   A side-loaded APK cannot install a dynamic feature at runtime (no Play split-install
   service). As of 2026-06-22 the CI ships **APK-only** (`BUILD_AAB: 'false'` in
   android.yml — owner: "just need the apk, no aab"). **On-demand deferral delivers ZERO
   benefit while distribution is sideload-APK-only** — the feature module would have to be
   `install-time`/fused into the APK, i.e. still shipped at install. This whole effort is a
   **non-starter until the Play AAB lane is re-enabled.** It only pays off for users who get
   the app from the Play Store.
4. **Testing requires Play internal app sharing / internal testing track.** DFM install
   flows can't be exercised on a `flutter run` debug build or a sideloaded release APK;
   they need the AAB uploaded to a Play testing track (or `bundletool` + a connected device).

## 3. Recommended approach

Two options; recommend **Option B** for robustness, with **Option A** as the cheaper probe.

**Option A — Flutter `deferred-components` (lighter, but limited).**
Make the Dart `sherpa_onnx` import a `deferred as so` import behind `loadLibrary()`, declare
a deferred component in `pubspec.yaml`, and let Flutter's tooling generate the Android
feature module + `loading-unit` mapping. *Risk:* Flutter's deferred-components flow is built
around Dart split units and assets; getting a third-party plugin's `.so` to land in the
feature module (not the base) is the part that may not work out of the box and needs a build
to confirm. Cheap to try; may dead-end.

**Option B — Manual Android Dynamic Feature Module (robust).**
- Create an Android dynamic-feature Gradle module (e.g. `:voice_runtime`) that carries the
  sherpa native libs / AAR, with `<dist:module dist:onDemand="true">` for Play and an
  `install-time` + `<dist:fusing dist:include="true"/>` fallback for the universal/sideload APK.
- App `Application` extends `FlutterPlayStoreSplitApplication` (or default + `SplitCompat.install`);
  add the Play Core (Feature Delivery) dependency. Note the existing R8 rules already keep
  `com.google.android.play.core.**` — wire that to the real API now.
- Gate engine init: before the first `so.initBindings()`, ensure the module is installed via
  `SplitInstallManager` (request + monitor + `SplitCompat`-refresh), surfaced through the
  existing `VoiceFeatureState.downloading/preparing` UI so it's one combined "getting ready"
  flow with the model download.
- Make the Dart `sherpa_onnx` import deferred (`loadLibrary()`), so Dart never resolves the
  FFI bindings until after the module is present.

## 4. Work breakdown (Option B)

1. Add a custom `Application` (or switch to `FlutterPlayStoreSplitApplication`) + Play Core
   Feature Delivery dependency; manifest `android:name`.
2. Scaffold the `:voice_runtime` dynamic-feature module; move/assign sherpa native libs to it;
   set `onDemand` + sideload fusing.
3. Wrap `VoiceModels`/`VoiceFeature.enable()` to install the module before model download and
   before `sherpa_voice_engine` init; add `SplitInstallManager` progress → existing voice UI.
4. Make the Dart sherpa import deferred; guard every call site (`sherpa_voice_engine.dart`).
5. Telemetry: `voice_runtime_install_{start,ok,fail,ms}` to PostHog (with user email, per repo rule).
6. CI: ensure the AAB build includes the feature; verify the sideload APK still fuses it in.
7. Test on a Play internal-testing track (or `bundletool`) on a real device: fresh install →
   enable voice → module installs → STT/TTS work; airplane-mode failure degrades gracefully.

## 5. Risks

- **May not pay off enough.** Net saving is only ~15–25 MB and **only** for non-voice users;
  voice users download it anyway. After the AvaVision removal + R8 shrink, the base install may
  already be small enough that this isn't worth the complexity.
- **DFM install failures** (offline, low storage, non-Play distribution) become a new voice
  failure mode — must degrade to today's "not ready" state, never crash.
- **Build/test friction:** can't validate headless or via sideload; needs Play track iterations.
- **Maintenance:** every sherpa_onnx bump must keep the module's lib assignment correct.

## 6. Recommendation — gate on the real number first

**Do not start this until the next CI build (with the AvaVision removal + R8 commits) reports
the actual arm64 APK / AAB size.** If that number already meets the target, skip this — the
effort/risk (est. **medium–high: several days + multiple Play-track iterations**) outweighs a
~15–25 MB win that voice users pay anyway. If install size is still a hard blocker, do Option A
as a half-day probe; fall back to Option B if it dead-ends.

**Hard precondition:** re-enable the Play AAB lane (`BUILD_AAB: 'true'`) first — there is no
point doing any of this while distribution is sideload-APK-only (§2.3).

**Decision required:** (a) is the app shipped via Play/AAB? if no, shelve → (b) measure
post-R8 size → (c) is base install size still a blocker for non-voice users? → if no, shelve;
if yes, Option A probe → Option B.
