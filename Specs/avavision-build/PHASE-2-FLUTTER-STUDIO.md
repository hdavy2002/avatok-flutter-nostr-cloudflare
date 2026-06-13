# PHASE 2 — Flutter app: Studio, Marketplace, Booking, API client. Runs in parallel.

> Carry `MASTER-PROMPT.md`. You build the Flutter creator + discovery + booking surfaces by mirroring
> AvaVoice. You do **not** build the live session screen — that is Phase 3 (it owns `session/`).
> You do **not** edit the registry/sidebar/create-listing (shared) — glue note instead. **No commit.**

## Pre-flight checklist (do BEFORE writing code)
- [ ] Read `PHASE-1-WORKER-BACKEND.md` **§A (schemas)** — that is the authoritative wire contract.
      All JSON fields are **`snake_case`**; your Dart models map them (e.g. `session_id` → `sessionId`
      in Dart, but the JSON key stays snake_case). If Phase 1 isn't merged, code against §A and note it.
- [ ] Opened `app/lib/core/avavoice_api.dart` and the AvaVoice studio files as method-for-method
      templates; confirmed the AvaVoice entry shape in `app/lib/core/app_registry.dart` (for the glue note).
- [ ] Located the real sidebar file — it is **`app/lib/shell/ava_sidebar.dart`** (NOT
      `app/lib/core/ava_sidebar.dart`; the master/other notes are stale). Confirm before writing the glue
      note so Phase Z edits the right file.
- [ ] Confirmed `scopedKey`/`readScoped` in `app/lib/core/account_storage.dart` and the `Avatar` pipeline
      in `app/lib/core/avatar.dart`.
- [ ] Noted the two Phase-3 symbols you depend on (`VisionSessionScreen`, `VisionPreviewPane`) and that
      you must NOT create `session/`.

## You own (create/edit ONLY these)
- `app/lib/core/avavision_api.dart` ← API client (NEW)
- `app/lib/features/avavision/avavision_home.dart` (NEW)
- `app/lib/features/avavision/agent_detail.dart` (NEW)
- `app/lib/features/avavision/booking_sheet.dart` (NEW)
- `app/lib/features/avavision/widgets.dart` (NEW — cards/badges)
- `app/lib/features/avavision/studio/agent_form_flow.dart` (NEW — the template-first wizard)
- `app/lib/features/avavision/studio/my_agents_screen.dart` (NEW)
- `app/lib/features/avavision/studio/agent_dashboard.dart` (NEW)
- `app/lib/features/avavision/studio/template_picker.dart` (NEW — category→use-case grid)
- `Specs/avavision-build/glue/PHASE-2-GLUE.md` (NEW — your glue note)

**Do NOT create `app/lib/features/avavision/session/` — that belongs to Phase 3.** When your code
needs to launch the session (e.g. a "Call Now" button), reference the agreed class
`VisionSessionScreen(agent:, language:, bookingId:, callId:)` and add a small stub import comment;
note in the glue note that Phase 3 provides it. Do not implement it.

## Read first (READ ONLY — your blueprint)
- `app/lib/core/avavoice_api.dart` — copy method-for-method into `avavision_api.dart`.
- `app/lib/features/avavoice/avavoice_home.dart`, `agent_detail.dart`, `booking_sheet.dart`,
  `widgets.dart` — copy structure.
- `app/lib/features/avavoice/studio/agent_form_flow.dart`, `my_agents_screen.dart`,
  `agent_dashboard.dart`, `voice_picker.dart` — copy structure.
- `app/lib/core/ui/zine.dart` + `zine_widgets.dart` — the design system (use these widgets/tokens only).
- `app/lib/core/account_storage.dart` — `scopedKey`/`readScoped` (per-account scoping is MANDATORY for
  any draft/pref you persist — rulebook #1).
- `app/lib/core/avatar.dart` — the CF AVIF avatar pipeline (rulebook #2).
- `Specs/avavision-templates.json` — the catalog the studio is built around.

## Build steps

### 1. `avavision_api.dart`
Mirror `AvaVoiceApi` as `AvaVisionApi`: `templates(platform)`, `voices()`, `marketplace(q)`,
`mine()`, `createAgent(...)`, `getAgent(id)`, `updateAgent(...)`, `publish(id,on)`, `uploadFile`,
`deleteFile`, `availability(id)`, `stats(id)`, `book(...)`, `myBookings()`, `cancelBooking(id)`,
`callNow(...)`, `sessionStart(...)`, `heartbeat(sid)`, `sessionStop(...)`, and **`snapshot(sid, jpegBytes)`**.
Define a `VisionAgent` model (mirror `VoiceAgent`) with the vision fields from master §4/§6
(`templateId, capability, overlayStyle, overlayEnabled, scoringMode, scoreLabel, visionMode,
agenticSnapshotEnabled, freeSnapshotsPerSession, platforms`). All calls go to `/api/avavision/*`.

### 2. Template picker (`studio/template_picker.dart`)
The **first** step of creation, the key difference from AvaVoice. A `Category` grid (7 categories from
the catalog, each a `zine` card with name + tagline + a capability badge), then a `Use-Case` list of
template cards. Selecting a template returns its full object to the form flow. Filter out templates not
available on the current platform (`platforms.android` on Android). Build it clean and tactile —
big tappable cards, capability/overlay/platform badges, the score label shown.

### 3. Agent form flow (`studio/agent_form_flow.dart`)
Copy AvaVoice's wizard but make it **template-first**:
1. **Pick a template** (push `template_picker.dart`) → prefills capability, overlay toggle + style,
   scoring mode, score label, starter prompt, suggested rate, platform badges.
2. **Identity** — name, role, system profile (seeded from `starter_prompt`), 1–5 listing photos
   (mandatory to publish — same rule as the rest of the marketplace).
3. **Voice** — reuse the voice picker pattern (copy `voice_picker.dart` into a local
   `studio/voice_picker.dart` OR import the avavoice one read-only? **Copy it** to stay decoupled).
4. **Vision options** — overlay on/off + style (constrained to the template's capability), scoring
   mode + score label, "Analyze my form" snapshot on/off + `free_snapshots_per_session`, save-snapshots
   off-by-default toggle. Show a **live preview pane**: a small camera view running the chosen overlay so
   the creator sees it before publishing. **The actual overlay engine is Phase 3's `VisionEngine`** —
   import the agreed widget `VisionPreviewPane(capability:, overlayStyle:)` and stub it with a comment;
   note the dependency in the glue note. If Phase 3 isn't merged yet, guard with a placeholder card so
   this file still compiles.
5. **Pricing & publish** — rate with live "you earn 50%" math, payer mode, session length 5/10/30/60,
   publish. Enforce the same client-side validation the Worker enforces.

### 4. Home / marketplace / detail / booking / dashboard / my-agents
Copy the AvaVoice equivalents, swapping API + adding capability/overlay/platform badges on cards and a
score-stats + snapshot-usage section on the dashboard. The "Call Now" / "Agent Busy" availability
behavior is identical (poll `availability`). Launching a call opens the (Phase 3) `VisionSessionScreen`.

### 5. Per-account scoping & analytics
Any draft autosave or pref MUST use `scopedKey`/`readScoped`. Fire `Analytics.screenViewed('avavision', ...)`
mirroring AvaVoice.

### 6. Idempotency on the client (money-moving actions)
The server keys escrow by `order_id` (PHASE-1 §B), but the client must still **guard against
double-submit**: disable the button + show a spinner while `createAgent`, `book`, `callNow`, and
`sessionStart` are in flight; never let a double-tap fire two bookings. Treat the eventual
`AGENT_BUSY` (409) and `SNAPSHOT_CAP_REACHED` (429) as normal, friendly states, not errors. Map all
response fields from §A's `snake_case` keys.

## Glue note (`Specs/avavision-build/glue/PHASE-2-GLUE.md`)
- The **app registry** entry to add in `app/lib/core/app_registry.dart` (mirror the AvaVoice entry).
- The **sidebar** entry in **`app/lib/shell/ava_sidebar.dart`** (the real path — NOT
  `app/lib/core/ava_sidebar.dart`; mirror the AvaVoice entry; not hidden).
- The **Create-Listing** option ("Create Vision Agent" next to "Create Voice Agent") — give the exact
  file + the snippet.
- The `VisionSessionScreen` and `VisionPreviewPane` symbols you depend on from Phase 3.
- Any analyzer errors that exist only because of the deferred shared wiring.

## Acceptance
- [ ] All listed files created, mirroring AvaVoice, template-first studio working.
- [ ] No `session/` files created; Phase 3 symbols only referenced + noted.
- [ ] No shared file edited; all shared edits captured in the glue note.
- [ ] Your files analyze clean except documented deferred-wiring errors.
- [ ] Graphiti episode written. **No commit.**
