# AvaTok — What to Capture, Screen by Screen

**Goal:** capture the *entire* in-app journey — every screen a user lands on, every meaningful action, and (especially) **every error** — and send it to PostHog so the AI can reconstruct exactly what a user did and where it broke, instead of guessing.

**Companion doc:** `posthog-situational-awareness-proposal.md` (architecture, identity = npub, EU region fix, SDK setup). This file is the **event catalog** — the actual list, grouped by the screen it belongs to.

**How to read each section:** every screen gets a `screen_viewed` event automatically (via the navigator observer), then a list of **Actions** to capture and **Errors** to capture. Errors are grounded in the real `catch` blocks and `SnackBar('… failed')` paths that exist in the code today.

### Standard properties on every event
`distinct_id` = npub · `platform` (ios/android) · `app_version` · `screen` · `service_name=avatok-app` · `trace_id`. Error events additionally carry: `error_domain`, `error_code`, `error_message`, `screen`, `action`, `is_fatal`.

### Person properties (set once, used for every breakdown)
These let you slice **every** chart by who the user is — country, age, account type:

| Property | Source | Example values |
|---|---|---|
| `$geoip_country_name`, `$geoip_country_code` | **Automatic** via GeoIP on ingest (client SDK adds it; server `/batch/` needs the user's `$ip` forwarded — see note below) | "Nigeria", "NG" |
| `$geoip_subdivision_1_name` | Automatic — **state / region** | "Lagos" |
| `$geoip_city_name` | Automatic — city | "Ikeja" |
| `account_kind` | Onboarding step 0 | `single` / `parent` / `enterprise` |
| `age_group` | New onboarding age field (bucket, never raw DOB) | `13-17`, `18-24`, `25-34`, `35-44`, `45-54`, `55-64`, `65+` |
| `phone_verified` | After OTP passes | bool |
| `email_verified` | After email link/code | bool |
| `liveness_status` | Video check (future) | `not_started` / `started` / `passed` / `failed` / `abandoned` |

> **Geo on server events:** PostHog derives country/state/city from the request IP. Client-SDK events get it automatically. For the server-side `consumers /batch/` path, forward the original user IP as `properties.$ip` (or set `$geoip_disable:false`) so backend events are geo-located too — otherwise they resolve to the Cloudflare edge, not the user.

> **Minors / compliance:** capture `age_group` as a bucket, never a raw birth date, and treat the `13-17` bucket per your child-safety policy (gating, parental account linkage). Don't send DOB as an event property.

---

## 0. Global / cross-cutting (fire on every screen)

These are app-wide, not tied to one screen — they're the backbone of "situational awareness."

| Event | Trigger | Key properties |
|---|---|---|
| `$screen` / `screen_viewed` | Any route push (auto via `PosthogObserver`) | `screen`, `previous_screen` |
| `app_opened` / `app_backgrounded` / `app_foregrounded` | Lifecycle (SDK `captureApplicationLifecycleEvents`) | `app_version` |
| `app_installed` / `app_updated` | First open / version change | `from_version`, `to_version` |
| `$exception` | **Uncaught crash** (wire `FlutterError.onError` + `PlatformDispatcher.onError` → `Posthog().capture('$exception', …)`) | `$exception_message`, `$exception_type`, `stack`, `screen` |
| `error_occurred` | **Any caught error** (the dozens of `catch` blocks below) | `error_domain`, `error_code`, `screen`, `action` |
| `network_request_failed` | Non-2xx / timeout in `ApiAuth`, `http`, WebSocket | `endpoint`, `status`, `latency_ms`, `screen` |
| `permission_prompted` / `permission_result` | Camera, mic, location, contacts, notifications | `permission`, `granted` (bool) |
| `session_started` / `session_ended` | App session boundaries | `duration_s` |

> The single most valuable change for troubleshooting is wiring `FlutterError.onError` and `PlatformDispatcher.onError` to `$exception` once, in `main.dart`. That alone turns every silent crash into a queryable event.

---

## 1. Welcome screen  ·  `features/onboarding/welcome_screen.dart`

| Event | Trigger |
|---|---|
| `screen_viewed` (welcome) | Screen open |
| `welcome_continue_tapped` | "Continue" button (`onContinue`) |

**Errors:** none in-screen (static screen).

---

## 2. Sign in / Sign up  ·  `features/auth/sign_in_screen.dart`

This screen handles Clerk sign-in, sign-up, and password reset (`_Mode.signIn/signUp/reset`).

| Event | Trigger |
|---|---|
| `screen_viewed` (sign_in) | Screen open |
| `auth_mode_switched` | `_switch()` — toggles between sign in / sign up / reset, `mode` |
| `signin_submitted` | `_submit()` in sign-in mode |
| `signup_submitted` | `_submit()` in sign-up mode |
| `password_reset_requested` | `_submit()` in reset mode |
| `auth_step_changed` | `_handleStep()` — Clerk multi-step (e.g. email verification), `step` |
| `auth_succeeded` | `_done()` → `onSignedIn` |
| `password_visibility_toggled` | eye icon (`_obscure`) |

**Errors (capture as `auth_failed` + `error_occurred`):**
- Clerk `signIn` / `signUp` rejected → the `_error` set in this screen. Properties: `mode`, `reason` (bad credentials / network / verification needed). This is the #1 place new users get stuck — capturing the failure reason here directly answers "why can't X sign up."

---

## 3. Onboarding flow  ·  `features/onboarding/onboarding_flow.dart`

7 steps: account kind → notifications → terms → key backup → profile (handle + name) → apps → done. See the dedicated step list — this is your activation funnel.

| Event | Trigger |
|---|---|
| `onboarding_started` | Flow opens |
| `onboarding_step_viewed` / `onboarding_step_completed` | Each `_step` change — `step_index` (0–6), `step_name` |
| `onboarding_account_kind_selected` | Single / Parent / Enterprise chosen — `account_kind` |
| `onboarding_notifications_choice` | Notification toggle — `enabled` |
| `onboarding_terms_agreed` | Terms checkbox |
| `onboarding_keys_backed_up` | Pub/priv key saved — `saved_pub`, `saved_priv` |
| `handle_availability_checked` | Live handle check (`_checkingHandle`) — `available` (bool), `reason` |
| `onboarding_profile_saved` | Handle + display name saved — `has_handle`, `has_name` |
| `onboarding_apps_configured` | App toggles — `apps_enabled[]` |
| `onboarding_completed` | `widget.onComplete` — `account_kind`, `apps_enabled[]` |

**Errors:** identity/profile persistence failure (the `catch` in `_bootstrap`/save), handle-check network failure → `error_occurred` with `action=handle_check` or `action=profile_save`.

> **Add an age step.** Onboarding has no age capture today. Add one field (date-of-birth picker or age-range select) and emit `onboarding_age_provided` with `age_group` only — then set it as a person property so every metric can break down by age.

---

## 3A. Phone (OTP) verification

Fires during signup/onboarding when the user verifies a phone number. Capture the full mini-funnel **and** every failure reason — OTP is a top drop-off and support point.

| Event | Trigger | Key properties |
|---|---|---|
| `otp_requested` | User asks for a code | `channel` (sms/whatsapp/call), `country_code` |
| `otp_sent` | Provider accepted send | `provider`, `latency_ms` |
| `otp_code_submitted` | User enters the code | `attempt` (1,2,3…) |
| `otp_verified` | Code accepted | `attempts_used`, `time_to_verify_s` |
| `otp_resend_tapped` | "Resend code" | `resend_count` |
| `phone_verification_completed` | Phone marked verified | sets `phone_verified=true` |

**Errors (`error_occurred`, `error_domain=otp`):**
- `otp_send_failed` — provider/SMS gateway rejected (`reason`: invalid_number, unsupported_region, provider_error, rate_limited).
- `otp_verify_failed` — `reason`: wrong_code, expired_code, too_many_attempts.
- `otp_rate_limited` — too many requests; `retry_after_s`.

These directly answer "are users failing OTP, and why / in which countries" (combine with `$geoip_country_name`).

---

## 3B. Email verification

Clerk drives email verification (the `auth_step_changed` event in §2 covers the handoff). Add explicit verification events so it's queryable on its own.

| Event | Trigger |
|---|---|
| `email_verification_sent` | Verification email/code dispatched |
| `email_verification_submitted` | User enters code / clicks link |
| `email_verified` | Success — sets `email_verified=true` |
| `email_verification_resend_tapped` | Resend |

**Errors (`error_occurred`, `error_domain=email_verification`):**
- `email_verification_failed` — `reason`: invalid_code, expired, link_mismatch, send_failed.

---

## 3C. Video / liveness verification  *(future — pipe events now)*

Not built yet, but wiring the event names now means data starts flowing the day the feature ships, and we can already build the funnel. This is the section you specifically want to watch for **abandonment**.

| Event | Trigger | Key properties |
|---|---|---|
| `liveness_check_started` | User enters the liveness/video step | `entry` (onboarding/settings) |
| `liveness_camera_permission_result` | Camera prompt answered | `granted` (bool) |
| `liveness_step_viewed` | Each sub-step (e.g., "turn head", "blink") | `step_name` |
| `liveness_capture_submitted` | Video/selfie sent for check | `attempt` |
| `liveness_passed` | Verification succeeded | `attempts_used`, `time_to_pass_s` |
| `liveness_failed` | Check rejected | `reason`: face_not_detected, spoof_suspected, timeout, poor_lighting |
| `liveness_abandoned` | User leaves the step without finishing | `last_step`, `seconds_on_step` |

**Errors (`error_occurred`, `error_domain=liveness`):** camera unavailable, upload failure, verification-service timeout, model error.

### Tracking "stopped at liveness and never came back"

Two complementary views (both scaffolded in PostHog now):

1. **Funnel** `…onboarding_completed → liveness_check_started → liveness_passed` with a **long conversion window** (e.g. 30 days). The step-2→step-3 drop is your "started liveness but never passed." Break it down by `$geoip_country_name` and `account_kind` to see *who* abandons.
2. **Cohort: "Liveness abandoners"** = did `liveness_check_started`, did **not** `liveness_passed`, and `last_seen > 3 days ago`. That's literally "hit the liveness wall and never returned" — drop them into a re-engagement list and watch the count over time.

---

## 4. App shell & sidebar  ·  `shell/ava_shell.dart`, `shell/ava_sidebar.dart`

The shell is the launcher: it pushes each app's screen (AvaTok, AvaLive, Profile, Settings, AvaBrain) and shows "Coming soon" for unbuilt apps.

| Event | Trigger |
|---|---|
| `app_launched_from_shell` | `_push()` of any app — `app_key`, `built` (bool) |
| `coming_soon_viewed` | Opening an unbuilt app — `app_key` (tells you which app users *want* that doesn't exist yet) |
| `sidebar_opened` | Drawer open |
| `invite_shared` | `shareGenericInvite()` in sidebar |
| `sign_out_tapped` | Sign-out from shell |

**Errors:** none direct, but `coming_soon_viewed` is high-value product signal (demand for unbuilt apps).

---

## 5. AvaTok — Chat list  ·  `features/avatok/chat_list.dart`

The messaging home. Tabs (chats / calls / contacts), per-chat flags, new chat menu.

| Event | Trigger |
|---|---|
| `screen_viewed` (chat_list) | Open |
| `chat_opened` | `_openChat()` — `chat_type` (dm/group) |
| `chat_tab_changed` | `_tab` switch — `tab` (chats/calls/contacts) |
| `chat_flag_toggled` | `_toggleFlag()` — `flag` (pinned/muted/archived/blocked) |
| `contact_removed` | `_removeContact()` |
| `new_chat_menu_opened` | `_openNewChatMenu()` |
| `add_contact_opened` / `new_group_opened` / `search_opened` | menu actions |
| `contact_added` | `_openAddContact` success — surfaces "Added X" |
| `custom_filter_added` | `_addCustomFilter()` |

**Errors (`error_occurred`):**
- Identity bootstrap / not-signed-in / offline → `catch` at `_bootstrap` (`action=bootstrap`).
- Inbox subscription failure → `catch` in `_startInbox` (`action=inbox_subscribe`).
- "That's your own account" / add-contact validation → `add_contact_rejected` with `reason`.

---

## 6. AvaTok — Chat thread  ·  `features/avatok/chat_thread.dart`

The most error-dense screen in the app (8 catch blocks) — DMs, groups, presence, typing, polls, location, calls, special messages. Instrument heavily.

| Event | Trigger |
|---|---|
| `screen_viewed` (chat_thread) | Open — `chat_type` |
| `message_sent` | `_send()` — `length`, `chat_type` |
| `message_special_sent` | `_sendSpecial()` — `type` (poll/contact/etc.) |
| `message_edited` | `_applyEdit()` |
| `poll_voted` | `_vote()` / `_applyVote()` — `poll_id`, `option` |
| `location_shared` | `_shareLocation()` success |
| `call_started_from_chat` | `_call()` — `kind` (audio/video) |
| `messages_marked_read` | `_markRead()` |
| `peer_presence_changed` | `_onPresence` — `online` (bool) |

**Errors (`error_occurred`) — each maps to a real `catch`:**
- Group message decode/parse failure → `_onGroupMsg` catch (`action=group_msg_decode`).
- DM decrypt failure ("legacy/plain text") → `_onDm` catch (`action=dm_decrypt`).
- Pinned-messages parse failure → `_loadChatExtras` catch (`action=load_pins`).
- **Call setup failure** → `_call()` catch + the `SnackBar` failure path (`action=call_setup`). High value — "my call won't connect."
- **Location failures** → permission denied ("Location permission needed") and fetch failure ("Couldn't get location") → `location_failed` with `reason`.

---

## 7. AvaTok — Call screen  ·  `features/avatok/call_screen.dart`

WebRTC 1:1 calls (ICE, offer/answer, mute, camera, hangup).

| Event | Trigger |
|---|---|
| `screen_viewed` (call) | Open — `kind` (audio/video) |
| `call_connecting` | `_start()` / `_newPC()` |
| `call_connected` | First connected ICE state |
| `call_ended` | `_end()` / `_endWith()` / `_hangup()` — `phase`, `duration_s` |
| `call_muted_toggled` | `_toggleMute()` — `muted` |
| `call_camera_toggled` | `_toggleCam()` / `_restartWithVideo()` — `on` |
| `call_speaker_toggled` | speaker button |

**Errors (`error_occurred`):**
- ICE fetch failure (falls back to STUN) → `_fetchIce` catch (`action=ice_fetch`).
- `getUserMedia` denied/unavailable (camera/mic) → wrap `_start` / `_restartWithVideo` (`action=get_user_media`, `reason`).
- Signaling socket drop / failed offer/answer → `_onSignal` (`action=signaling`).
- `call_failed` summary event with `phase` so you can see *where* in setup calls die.

---

## 8. AvaTok — Contacts & contact actions  ·  `contacts.dart`, `add_contact_sheet.dart`, `contact_profile_screen.dart`, `search_screen.dart`

| Event | Trigger |
|---|---|
| `contact_lookup_started` | `_runDirectory()` in search — `query_type` (email/handle) |
| `contact_found` / `contact_not_found` | directory result |
| `contact_chat_opened` | `_openContactChat()` |
| `contact_invited` | `DeviceContactsService.invite()` |
| `npub_copied` | copy button (contact profile / search) |
| `group_opened_from_search` | `_openGroup()` |

**Errors (`error_occurred`):** the 4 `catch` blocks in `contacts.dart` — local save, profile fetch (`kProfileUrl`), and directory lookups (`action=contacts_save` / `profile_fetch` / `directory_lookup`).

---

## 9. AvaTok — New group & group info  ·  `new_group_screen.dart`, `group_info_screen.dart`

| Event | Trigger |
|---|---|
| `group_create_started` | `_create()` |
| `group_created` | success — `member_count` |
| `group_members_invited` | invite step |
| `group_info_viewed` | group info open |

**Errors:** group create/broadcast failure → `_create` catch ("members can be invited later") → `error_occurred` `action=group_create`.

---

## 10. AvaTok — Status  ·  `features/status/status_screen.dart`

Stories/status (text + image posts).

| Event | Trigger |
|---|---|
| `screen_viewed` (status) | Open |
| `status_compose_opened` | `_addSheet()` |
| `status_posted` | `_post()` — `media_type` (text/image) |
| `status_viewed` | `_view()` — viewing someone's status |

**Errors:** post publish failure → `_post` catch (`action=status_post`); image pick/upload failure on `_addImage`.

---

## 11. AvaTok — Media library & video player  ·  `media_library_screen.dart`, `video_player_screen.dart`, `media.dart`

| Event | Trigger |
|---|---|
| `media_library_opened` | Open |
| `media_opened` | tap a media item — `media_type` |
| `video_play_started` / `video_play_completed` | player — `duration_s` |
| `media_uploaded` | upload success — `size`, `mime` |

**Errors:** upload/download/decode failures → `media_failed` (`action=upload`/`download`/`decode`).

---

## 12. AvaLive — Discovery  ·  `features/avalive/avalive_discovery.dart`

| Event | Trigger |
|---|---|
| `screen_viewed` (avalive_discovery) | Open |
| `live_list_loaded` | `_load()` — `count` |
| `live_stream_opened` | `_watch()` |
| `go_live_tapped` | `_goLive()` |
| `live_list_refreshed` | refresh button |

**Errors:** stream list fetch failure/timeout → `_load` catch (`action=live_list`, includes the 10s timeout case).

---

## 13. AvaLive — Live screen (broadcast/watch)  ·  `features/avalive/live_screen.dart`

WHIP (broadcast) / WHEP (watch) WebRTC.

| Event | Trigger |
|---|---|
| `screen_viewed` (live) | Open |
| `go_live_started` | `_goLive()` |
| `go_live_succeeded` | publish connected |
| `watch_started` | `_watch()` |
| `live_ended` | `_reset()` — `role` (broadcaster/viewer), `duration_s` |

**Errors (`error_occurred`) — explicit `throw`s here make these clean:**
- "Camera & mic permission required" → `_goLive` (`reason=permission`).
- "No WHIP URL (Stream not ready)" / "No WHEP URL" → stream not provisioned (`reason=no_url`).
- `Server {status}` / `WHIP/WHEP {status}` → backend rejection (`action=live_signal`, `status`).
- Generic `_goLive`/`_watch` catch → `live_failed` with `role`.

---

## 14. AvaBrain — Agent inbox  ·  `features/avabrain/agent_inbox_screen.dart`

The agent activity hub (approve / dismiss / undo actions, TTS playback).

| Event | Trigger |
|---|---|
| `screen_viewed` (agent_inbox) | Open |
| `agent_inbox_loaded` | `_load()` — `item_count` |
| `agent_action_taken` | `_act()` — `action` (approve/dismiss/undo) |
| `agent_tts_requested` | `_listen()` |
| `agent_inbox_refreshed` | refresh |

**Errors (`error_occurred`):**
- Inbox load failure → `_load` catch (`action=inbox_load`).
- Action failure → `_act` catch → surfaces "Failed: $e" (`action=agent_act`, `agent_action`).
- TTS synthesis failure → `_listen` catch → "Couldn't synthesize" (`action=tts_synthesize`).

---

## 15. Communities  ·  `communities_tab.dart`, `community_detail_screen.dart`

| Event | Trigger |
|---|---|
| `screen_viewed` (communities) | Open |
| `communities_loaded` | `_load()` — `count` |
| `community_create_started` / `community_created` | `_createCommunity()` |
| `community_join_attempted` | `_joinByCode()` — `via=code` |
| `community_joined` / `community_not_found` | join result |
| `community_opened` | `_openDetail()` |
| `channel_added` | `_addChannel()` |
| `community_members_added` | `_addMembers()` — `count` |
| `community_code_shared` | `_shareCode()` |
| `community_left` | `_leave()` |

**Errors:** group-info broadcast failures (`_broadcastGinfo` / `_publishGinfo` catches → `action=ginfo_broadcast`); "Community not found" → already an event above; load failure → `_load` catch.

---

## 16. Explore (marketplace)  ·  `explore_home.dart`, `listing_detail.dart`, `product.dart`

| Event | Trigger |
|---|---|
| `screen_viewed` (explore) | Open |
| `explore_category_changed` | `_cat` tap — `category` |
| `listing_opened` | open `ListingDetail` — `product_id` |
| `checkout_tapped` | checkout button (currently stub: "wires to Nostr payments next") — capture now so demand is measurable pre-launch |

**Errors:** none yet (checkout is stubbed); add `checkout_failed` when payments land.

---

## 17. Notifications  ·  `features/notifications/notifications_screen.dart`

| Event | Trigger |
|---|---|
| `screen_viewed` (notifications) | Open |
| `notifications_loaded` | `_load()` — `count`, `unread` |
| `notification_opened` | tap a notification — `type` |

**Errors:** notification fetch failure → `_load` (`action=notifications_load`). Also pair with `permission_result` for push permission.

---

## 18. Profile  ·  `features/profile/profile_screen.dart`

| Event | Trigger |
|---|---|
| `screen_viewed` (profile) | Open |
| `profile_save_started` | `_save()` |
| `profile_saved` | success — surfaces "people can now find you" |
| `npub_copied` | copy button |

**Errors:** profile save failure → wrap `_save` → `error_occurred` `action=profile_save`.

---

## 19. Settings  ·  `features/settings/settings_screen.dart`

| Event | Trigger |
|---|---|
| `screen_viewed` (settings) | Open |
| `account_kind_changed` | `_setKind()` — `account_kind` |
| `account_backup_started` | `_runBackup()` |
| `account_backup_succeeded` | success — "Download link copied" |
| `backup_link_copied` | copy backup link |
| `key_revealed` | reveal private key (`_revealKey`) — sensitive, capture the action **without the key** |
| `account_delete_requested` / `account_deleted` | `_delete()` (pairs with server `account_deleted`) |
| `signed_out` | sign-out button |

**Errors (`error_occurred`):**
- Backup failure → `_runBackup` catch → both "Backup failed — please try again" and "check your connection" paths (`action=account_backup`, `reason`).
- Delete failures → the two swallowed catches in `_delete` (server delete + Clerk delete) — currently silent; capture them so a failed deletion is visible (`action=account_delete`, `stage=server`/`clerk`).

---

## 20. Coming-soon placeholders  ·  `shell/coming_soon.dart`

| Event | Trigger |
|---|---|
| `coming_soon_viewed` | Any unbuilt app opened — `app_key`, `app_name` |

No errors — but this is the cleanest measure of which of the 13 unbuilt apps (AvaAI, AvaAgent, AvaVoice, AvaTweet, AvaBook, AvaGram, AvaWeb, AvaNote, AvaTube, AvaAds, AvaLinked, AvaTind, AvaMatri) people actually try to open.

---

## Error taxonomy (the part you care most about)

Standardize **one** error event so they're all queryable together:

```dart
Analytics.capture('error_occurred', {
  'error_domain': 'call_setup',   // see domains below
  'error_code': 'get_user_media', // specific failure
  'error_message': e.toString(),  // never include keys/PII
  'screen': 'call',
  'action': 'start',
  'is_fatal': false,
});
```

Plus `$exception` for uncaught crashes (wired once in `main.dart`).

**Error domains across the app (each maps to real `catch` sites found in the code):**

| Domain | Screens it fires on |
|---|---|
| `auth` | sign-in/up failures |
| `identity` / `bootstrap` | chat_list bootstrap, onboarding identity |
| `messaging` | chat_thread (dm_decrypt, group_msg_decode, load_pins) |
| `call_setup` | call_screen (ice_fetch, get_user_media, signaling), chat_thread call |
| `live` | live_screen (permission, no_url, signal status), discovery load |
| `media` | uploads/downloads/decode, status image |
| `agent` | agent inbox load/act, tts synthesize |
| `community` | load, ginfo_broadcast, join |
| `profile` | profile_save, handle_check |
| `account` | backup, delete (server + clerk), kind change |
| `network` | any non-2xx/timeout from `ApiAuth`/`http`/WS |
| `crash` | `$exception` — uncaught |

Once these flow in, the AI workflow is: you give me an npub (or handle + rough time), I pull that person's `screen_viewed` trail interleaved with `error_occurred` / `$exception`, and I can say "they hit `call_setup / get_user_media` on the call screen at 14:02 — camera permission was denied," instead of guessing.

---

## Suggested capture priority

1. **Crashes + caught errors** (`$exception`, `error_occurred`) and `screen_viewed` — the troubleshooting backbone. *(Phase 1)*
2. **Auth + onboarding** events — where new users are lost. *(Phase 2)*
3. **AvaTok messaging + calls** (chat_thread, call_screen) — highest usage, most failure points. *(Phase 3)*
4. **AvaLive, AvaBrain, Communities, Status** — feature depth. *(Phase 4)*
5. **Explore, Notifications, Profile, Settings, coming-soon demand**. *(Phase 5)*
