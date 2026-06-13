# PHASE-2 GLUE NOTE — Flutter Studio / Marketplace / Booking / API client

Phase 2 owns the AvaVision creator + discovery + booking surfaces, mirroring AvaVoice.
**No commit.** Phase Z applies every shared-file change below.

## Files created (Phase 2, all NEW)
- `app/lib/core/avavision_api.dart` — `AvaVisionApi` + models (`VisionAgent`, `VisionTemplate`,
  `VisionCategory`, `VisionPlatforms`, `VisionVoice`, `AgentAvailability`, `VisionBooking`,
  `AgentDayStats`, `VisionSnapshotResult`) + money/label helpers. All calls hit `/api/avavision/*`.
  Mirrors `avavoice_api.dart` 1:1 plus the vision fields and the NEW `templates()` + `snapshot()`.
- `app/lib/features/avavision/widgets.dart` — cards/badges (`AgentCard`, `MiniPill`,
  `AvailabilityChip`, `VisionBadge`, `FreeBadge`, `CapabilityBadge`, `OverlayBadge`, `ScoreBadge`,
  `PlatformBadges`, `visionStickers`, `pickLanguage`, `fmtWhenMs`).
- `app/lib/features/avavision/avavision_home.dart` — `AvaVisionHome` (marketplace + my bookings + studio entry).
- `app/lib/features/avavision/agent_detail.dart` — `AgentDetailScreen` (Call Now / Book / Join → session).
- `app/lib/features/avavision/booking_sheet.dart` — `showBookingSheet`.
- `app/lib/features/avavision/studio/template_picker.dart` — `TemplatePickerScreen` (category→use-case, the template-first first step).
- `app/lib/features/avavision/studio/agent_form_flow.dart` — `AgentFormFlow` (5-step template-first wizard).
- `app/lib/features/avavision/studio/voice_picker.dart` — `VoicePicker` (local copy of AvaVoice's, decoupled).
- `app/lib/features/avavision/studio/my_agents_screen.dart` — `MyAgentsScreen`.
- `app/lib/features/avavision/studio/agent_dashboard.dart` — `AgentDashboardScreen` (+ avg/peak score + snapshot usage).

**No `session/` files were created by Phase 2** (Phase 3 owns it — see "Cross-phase" below).
**No shared file was edited.** All shared changes are listed here for Phase Z.

---

## SHARED-FILE CHANGES FOR PHASE Z (copy-paste)

### 1. `app/lib/core/remote_config.dart` — kill-switch getter (mirror `avavoiceEnabled`)
Add next to `avavoiceEnabled` (line ~36):
```dart
  static bool get avavisionEnabled => _b('avavisionEnabled', true);
```
> Until added, `avavision_home.dart`'s `RemoteConfig.avavisionEnabled` is an EXPECTED
> deferred-wiring analyzer error (the only one in that file).

### 2. `app/lib/core/app_registry.dart` — registry entry (sidebar renders `tier == standard` from here)
Add in the `// ---- standard ----` block (right after the `avavoice` line, ~line 37):
```dart
  AppEntry('avavision', 'AvaVision', 'AI vision coaches', Icons.visibility, Color(0xFFA06AF0)),
```
> The sidebar (`app/lib/shell/ava_sidebar.dart`) auto-renders standard registry entries — no
> separate sidebar edit is needed beyond this registry line. (Confirmed: `ava_sidebar.dart`
> contains no per-app `avavoice` literal; it iterates `kAppRegistry`.)

### 3. `app/lib/core/apps.dart` — parallel `AppDef` list (if still used)
Mirror the AvaVoice `AppDef` (~line 25):
```dart
  AppDef('avavision', 'AvaVision', 'AI vision coaches', Icons.visibility, Color(0xFFA06AF0)),
```

### 4. `app/lib/shell/ava_shell.dart` — route dispatch (this is where ids open screens)
Add the import (next to line 14 `import '../features/avavoice/avavoice_home.dart';`):
```dart
import '../features/avavision/avavision_home.dart';
```
Add the case (next to the `case 'avavoice':` block, ~line 93):
```dart
      case 'avavision':
        _push(const AvaVisionHome());
        return;
```

### 5. Create-Listing flow — "Create Vision Agent" option
File: `app/lib/features/listings/create_listing_flow.dart`.
- Add import (next to line 13 `import '../avavoice/studio/agent_form_flow.dart';`):
```dart
import '../avavision/studio/agent_form_flow.dart' as avavision;
```
- Add a handoff in `_continue()` (right after the existing `ai_agent` handoff, ~line 140):
```dart
    if (_step == 0 && _kind == 'ai_vision_agent') {
      Analytics.capture('listing_pipeline_ai_vision_agent_handoff');
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(builder: (_) => const avavision.AgentFormFlow()),
      );
      return;
    }
```
- Add the radio card in `_stepType()` (after the `ai_agent` card, ~line 368):
```dart
        const SizedBox(height: 10),
        _radioCard('ai_vision_agent', 'AI vision agent',
            'A camera coach that SEES the user — form, technique, live score (AvaVision)',
            PhosphorIcons.eye(PhosphorIconsStyle.bold), Zine.lilac),
```
> Note the `as avavision` import alias — both AvaVoice and AvaVision export a class named
> `AgentFormFlow`, so the create-listing file must disambiguate.

---

## CROSS-PHASE CONTRACTS RELIED ON

### Phase 1 (Worker) — wire contract
- All request/response fields are **snake_case** per PHASE-1 §A. Models map snake_case → camelCase
  Dart getters. `VisionAgent` parses both `availability:{state,active,max}` (marketplace) and a flat
  `active_calls`/`max` fallback. `/sessions/start` extra vision fields, `/snapshot` response, and the
  publish `{error:'VALIDATION', field, detail}` shape are all consumed as specified.
- Money/idempotency: every money/counter call goes through `_money(...)` with an `Idempotency-Key`
  header + one same-key retry (PHASE-1 §B). Buttons are disabled + spinnered while `createAgent`,
  `book`, `callNow`, `sessionStart` are in flight (double-submit guard). `AGENT_BUSY` (409) and
  `SNAPSHOT_CAP_REACHED` (429) are treated as friendly states, not errors.

### Phase 3 (session) — **its `session/` dir is ALREADY PRESENT in the working tree**
Phase 3 has run in a parallel session. It exposes the agreed symbols with matching constructors:
- `VisionSessionScreen({required VisionAgent agent, required String language, String? bookingId, String? callId})`
- `VisionPreviewPane({required String capability, required String overlayStyle})`

**IMPORTANT for Phase Z — VisionAgent duplication must be reconciled:**
Phase 3's `session/vision_api_stub.dart` defines its **own** local `VisionAgent` (a deliberate stub,
documented in that file's header) because Phase 2 might not have been merged when it ran. So
`VisionSessionScreen.agent` is currently typed to *Phase 3's* `VisionAgent`, **not** Phase 2's
canonical `core/avavision_api.dart` `VisionAgent`. Therefore Phase 2 does **not** import
`vision_session_screen.dart` directly — that would be a type mismatch. Instead:
- `agent_detail.dart` references `VisionSessionScreen(...)` with the import commented out. These two
  references are the EXPECTED deferred-wiring analyzer errors for that file.
- **Phase Z must**: (a) delete Phase 3's local `VisionAgent` in `session/vision_api_stub.dart` and
  point it at `../../../core/avavision_api.dart` (Phase 3's own header says the swap is import-only),
  then (b) uncomment/add `import 'session/vision_session_screen.dart';` in `agent_detail.dart`.
  After that, the `VisionSessionScreen` references resolve with the correct type — zero errors.

**VisionPreviewPane:** Phase 2's wizard (`agent_form_flow.dart`, step "Vision options") renders a
local `_VisionPreviewPlaceholder` so it compiles standalone and doesn't pull the camera channel into
the creation flow. Phase 3's real `VisionPreviewPane(capability:, overlayStyle:)` takes only strings
(no `VisionAgent`), so Phase Z *may* optionally swap the placeholder for the real widget if a live
preview in the wizard is desired. Not required for correctness.

---

## EXPECTED (documented) analyzer errors — ALL are deferred shared wiring
1. `app/lib/features/avavision/avavision_home.dart` → `RemoteConfig.avavisionEnabled` undefined until
   shared change #1 lands.
2. `app/lib/features/avavision/agent_detail.dart` → `VisionSessionScreen` undefined until the Phase 3
   import is wired (shared/Phase-Z reconciliation above).

No other new errors are expected from Phase 2 files.

## Drift / assumptions vs MASTER
- `MIN_RATE_PER_HOUR`: client enforces **≥ $1/hr (100 coins)** mirroring AvaVoice, since
  `Specs/avavision-build/PRICING.md` was not consulted for a vision-specific minimum. **// PRICING-TBD**
  — if Phase 0/1 set a higher MIN, update the `_validStep()` rate check in `agent_form_flow.dart` and
  the `book`/publish messaging to match.
- `vision_mode` is computed client-side as `both` when the deep snapshot is enabled, else `live`
  (live always runs in a session). Server is authoritative; this is just the create/update payload.
- Platform coherence at create time: `platforms.ios` is set false for
  `face_landmark | segmentation | holistic` (no free iOS engine — master §3/§6); Android+Web always
  true. The Worker re-validates at publish.

## Isolated-build result
No local Flutter toolchain on this machine (APK builds in GitHub Actions CI). Verified by hand:
brace/paren balance clean on all 10 Phase-2 files; every `PhosphorIcons.*` used is in the set already
referenced elsewhere in `app/lib`; all `Zine*`/`ZineText`/`ApiAuth`/`Analytics`/`Avatar`/`CoverImage`
APIs checked against their definitions; no stray `avavoice`/`VoiceAgent` symbol references remain
(only doc comments). The two deferred errors above are the only expected analyzer failures.
