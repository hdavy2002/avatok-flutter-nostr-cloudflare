# AvaTOK UI Redesign Handover

Date: 2026-08-21  
Project: `/Users/davy/Documents/websites/avaTOK-2-Flutter`  
Target environment: production (`.avatok-target` is `prod`)  
Release status: not shipped; do not trigger a build automatically

## Objective

Finish the screenshot-driven AvaTOK visual redesign requested by the owner. The work must be implemented as shared components wherever possible, then reviewed screen by screen. The owner specifically wants the app to feel like one coherent product: the same dark indigo/gold wave language, readable white system/header icons, responsive titles, Indian/Holi color accents, and controls that never disappear behind the waves.

The owner explicitly does **not** want a build triggered during implementation. A production release may only be dispatched after the owner explicitly says `ship it`, the release revision is confirmed on `main`, the working tree is clean, and the normal production approval/release gates are followed.

## Requested behavior and visual requirements

### 1. Unreachable / missed-call screen

- Combine the profile photo, circular petal decoration, black dotted orbit, and temple bell into one transparent composition.
- The composition must be one widget/image in the scrolling content. When the page scrolls, the profile photo, petals, dotted orbit, bell, and decoration must move together.
- Center the profile photo inside the circular decoration.
- Move the small truck/vehicle illustration farther away from the petal orbit so it is clearly separate from the flowers.
- Add tasteful Indian/Rajasthani/Holi motifs around the empty space without making the screen noisy.
- Reuse the existing design tokens and motif painters/assets. Do not introduce raw color literals if the design guard forbids them.
- The unreachable notification/card must show the caller’s actual profile avatar when available, with a safe fallback avatar when not.
- Keep action buttons such as Call again, Message, Talk to Ava, Leave a voice note, and Leave a text note visually distinct using Indian/Holi accents, while preserving readable contrast and responsive sizing.

Likely code areas:

- `app/lib/core/ui/call_failure_copy.dart`
- Search for the unreachable-call route/card and its action buttons with `rg -n "unreachable|didn.t respond|Call again|Leave a voice" app/lib`.
- `app/lib/features/avatok/call_screen.dart`
- `app/lib/features/avadial/*call*screen.dart`
- `app/lib/core/ui/rajasthani_motifs.dart`
- Existing avatar widgets and `Avatar`/`AvatarViewer` implementations.

### 2. Shared header and footer

- Every major page must inherit the shared header/footer treatment: messenger, Marketplace, AvaBrain, Calls/Inbox, Settings/account drawer, profile, and related app roots.
- Header content should include the hamburger/menu affordance where appropriate, page/app name, wallet balance chip, profile avatar, and notification bell.
- Only the page name changes between pages.
- Use `AvaTOK` everywhere as the visible brand spelling. `TOK` must remain uppercase.
- Long page names must be shortened with ellipsis, normally after roughly 4–6 visible characters, so the wallet/avatar/bell controls are not pushed off-screen.
- Header and footer wave seams must be decorative overlays, not layout siblings that create blank cream strips or hide scrolling content.
- The footer’s swipe-up/app-switcher treatment must stay visually consistent across roots.
- Status-bar icons (time, Wi-Fi, battery, signal) must be white when rendered over the dark header/footer band.
- Do not make the search bar sticky unless the screen already requires it. The requested behavior is scrolling content with the search bar positioned below the header wave.

Likely shared code:

- `app/lib/shell/v2/shell_chrome.dart`
- `app/lib/shell/v2/app_switcher_bar.dart`
- `app/lib/shell/v2/shell_destinations.dart`
- `app/lib/shell/shell_v2.dart`
- `app/lib/shell/v2/talk_root.dart`
- `app/lib/shell/v2/avadial_root.dart`
- `app/lib/shell/v2/services_root.dart`
- `app/lib/core/ui/zine_widgets.dart` (`ZineAppBar`)
- `app/lib/core/ui/rajasthani_motifs.dart` (`SeamOverlay`, `DoubleWaveSeam`)
- `app/lib/core/theme.dart` (`SystemUiOverlayStyle` handling)
- `app/lib/core/ui/avatok_dark.dart` (`AdSearchDock`)

### 3. Search-bar placement rule

This is a hard acceptance requirement:

> Every search bar starts below the tip of the header wave. It must never touch, overlap, or sit behind the golden wave.

The search bar should scroll with the page unless the individual screen explicitly needs a sticky search control. Messages/list rows should be able to scroll behind the header region after the search bar has moved away.

Current shared implementation added a top margin to `AdSearchDock` in `app/lib/core/ui/avatok_dark.dart`. Review this on every host because some screens wrap the dock in their own padding and some headers are taller than others. Avoid double-spacing on small screens.

Known hosts:

- `app/lib/features/avatok/chat_list.dart`
- `app/lib/features/avatok/groups_tab.dart`
- `app/lib/features/avatok/calls_screen.dart`
- `app/lib/features/avadial/inbox/inbox_list_screen.dart`
- Marketplace search, which uses a regular `TextField` and needs equivalent spacing below its shared header/wave.

### 4. Chat thread and composer

- Remove the indigo-on-indigo treatment inside the message thread where it harms contrast. Use warm paper, saffron/haldi, rani, turquoise, or other approved Indian/Holi tokens with readable dark/white text.
- Composer/input area must sit above the footer wave, never underneath it.
- Emoji, @mention, camera, attachment, clipboard/paste, and microphone controls must be visible against the composer background.
- Keep the input background visually separate from the indigo footer.
- Preserve the existing shared audio player behavior and local-first media cache rules.

Likely code:

- `app/lib/features/avatok/chat_thread.dart`
- `app/lib/features/avatok/chat_thread/composer.dart`
- `app/lib/features/avatok/chat_thread/bubbles.dart`
- `app/lib/features/avatok/chat_thread/voice.dart`
- `app/lib/core/ui/messenger_theme.dart`
- `app/lib/core/audio_playback_service.dart`

### 5. Recipient voice-note playback

The owner reports: a voice note plays on the sender’s phone, but on the recipient’s phone tapping play does nothing.

Trace the complete path:

1. Recorder creates the audio bytes.
2. `_upload` creates the media object/envelope.
3. The outgoing message envelope is sent through the DM/InboxDO path.
4. Recipient parses the incoming envelope into `ChatMedia`.
5. Recipient resolves/downloads/decrypts the media.
6. `AudioPlaybackService` receives non-empty bytes and starts playback.

Check especially:

- Whether voice-note media is sent in the same envelope format as other `gmedia` messages.
- Whether the recipient receives `media`, `kind`, `id`, `contentType`, and encryption/plaintext metadata.
- Whether `MediaService.downloadAndDecrypt` is called for recipient media and whether its result is empty.
- Whether the current plaintext voice-note flag is consistent between upload, outbox retry, and recipient download.
- Whether the recipient’s message parser incorrectly treats the voice-note envelope as a control/raw envelope.
- Whether the stable playback track ID is available after a cold restart.
- Whether an audio MIME/container mismatch (`audio/mp4`, `.m4a`, WAV, etc.) causes Android playback failure.
- Add useful telemetry for each failure stage, including sender and recipient identifiers where the existing telemetry contract requires them.

Do not weaken per-account scoping or private-media rules. Do not make private encrypted media server-readable merely to make playback easier.

### 6. Marketplace

- Remove duplicate/stacked Marketplace title sections.
- Use the shared header/wave treatment.
- Put Marketplace search below the wave tip.
- Use a shortened title such as `Market…` on narrow screens.
- Give country/category/vehicle filters different Indian/Holi accent colors with clear selected/unselected states and a restrained shadow/outline.
- Keep empty-state and listing cards readable on small screens.

Likely code:

- `app/lib/features/marketplace/marketplace_browse.dart`
- `app/lib/features/marketplace/marketplace_hub.dart`
- `app/lib/features/marketplace/intent_theme.dart`
- `app/lib/shell/v2/services_root.dart`

### 7. AvaBrain

- Restore/retain the session-list landing page before opening a chat.
- Session rows need rename, archive, delete, and new-session actions.
- Tapping a session opens the historic chat thread.
- Chat composer must sit above the footer wave and use a contrasting non-indigo surface.
- Use the shared header treatment and short responsive titles.

Likely code:

- `app/lib/features/ava_companion/companion_home.dart`
- `app/lib/features/ava_companion/companion_thread.dart`
- `app/lib/features/avabrain/agent_inbox_screen.dart`
- `app/lib/features/avabrain/brain_settings_screen.dart`
- `app/lib/features/askava/askava_screen.dart`

### 8. Calls / Inbox

- Use the shared wave/header treatment instead of isolated cream or indigo bars.
- Keep status icons white over dark header bands.
- Replace indigo call-recording cards with a contrasting Indian/Holi surface where black text and icons remain visible.
- New/unread recordings should have a clearly visible status dot, icon, date, and metadata.
- Keep the search bar below the wave tip.
- Preserve avatar/caller-name resolution and unread/heard state.

Likely code:

- `app/lib/features/avadial/inbox/inbox_list_screen.dart`
- `app/lib/features/avadial/inbox/inbox_thread_screen.dart`
- `app/lib/features/avadial/inbox/call_recording_card.dart`
- `app/lib/features/avadial/inbox/call_recording_detail_screen.dart`
- `app/lib/shell/v2/avadial_root.dart`

### 9. Settings/account drawer

- Do not use an indigo surface behind black account/settings/logout text.
- Keep the profile avatar and AvaTOK logo readable.
- Keep logout clearly above/inside the footer wave rather than underneath it.
- Use the shared header/footer treatment and white status icons.
- Preserve the existing account-scoped settings behavior.

Likely code:

- `app/lib/shell/ava_sidebar.dart`
- `app/lib/shell/v2/shell_chrome.dart`
- `app/lib/features/identity/identity_screen.dart`
- `app/lib/features/profile/profile_screen.dart`
- `app/lib/features/settings/*`

## Existing commits and current state

The following UI commits are already on remote `main`:

- `b96298bc` — shared AvaTOK chrome, white status-bar behavior, composer color, visible AvaTOK labels.
- `65b3cea9` — shared page-title/header treatment and Marketplace header/colors.
- `200b5ff5` — shared `AdSearchDock` top spacing below wave tips.

The branch also contains later Stream/call commits from other work. Do not rewrite or reset them.

The working tree has unrelated uncommitted changes in app configuration, specifications, and worker call/wallet files. Preserve them. Do not use `git reset --hard`, `git checkout --`, broad `git add -A`, or any destructive cleanup.

## Engineering constraints

- Read the project `AGENTS.md` and the Cloudflare rulebook before changing architecture-sensitive code.
- Use Graphiti group ID `proj_avaflutterapp` for project memory reads/writes when tools are available.
- Use Graphify for structural code questions; run `graphify update .` after modifying code.
- No local builds, Flutter analyze, npm builds, or deployment commands. CI/GitHub Actions owns builds.
- Do not trigger `android.yml` during implementation.
- All per-account state must use the existing account-scoping helpers.
- Do not reintroduce Nostr or a central D1 message store.
- Keep voice/media behavior aligned with existing Cloudflare-native InboxDO and MediaService architecture.
- Use `scripts/git_safe_commit.py` with explicit paths. One issue per commit.
- Do not include unrelated working-tree files in commits.

## Review checklist

Before handing back:

- Search all visible user-facing strings for `AvaTalk` and change branding to `AvaTOK` where it is a product label.
- Search all `AppBar`, `ZineAppBar`, `AdSearchDock`, `DoubleWaveSeam`, and `SeamOverlay` call sites.
- Confirm every search dock has enough separation from the wave at compact, normal, and wide phone widths.
- Confirm header titles ellipsize before wallet/avatar/bell controls overflow.
- Confirm status icons are white over every dark header/footer band.
- Confirm profile artwork is a single scrollable composition, not independent overlay widgets.
- Confirm unreachable cards show the correct profile avatar.
- Confirm recipient voice-note playback works from a cold-open path, not only sender-local memory.
- Confirm no black text/icons sit on indigo surfaces without sufficient contrast.
- Confirm no composer or logout control is hidden behind the footer wave.
- Review `git diff --check` and the exact staged paths.
- Do not ship until the owner explicitly requests it and the working tree/release gate is clean.

## Suggested commit split

1. `[UI-HEADER-2026] Unify responsive header and wave spacing`
2. `[UI-SURFACES-2026] Redesign Marketplace Brain Calls Settings`
3. `[UI-CALL-2026] Fix unreachable profile artwork and voice playback`

After review, report the commit hashes, changed screens, known limitations, and explicitly state that no build was triggered.
