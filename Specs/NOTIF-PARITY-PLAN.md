# AvaTOK — WhatsApp-parity notifications (Android)

**Status:** Phase 0 + Phase 1 written and committed, NOT yet deployed or built ·
**Scope:** production feature · **Owner ask:** 2026-08-17

| Phase | Issue ids | State |
|---|---|---|
| 0 | `NOTIF-ICON-1`, `NOTIF-PAYLOAD-1`, `NOTIF-FLAGS-1` | committed |
| 1 | `NOTIF-STYLE-1` | committed |
| 2 | `NOTIF-ACTIONS-1` | committed + server live, **needs a build** |
| 3 | `NOTIF-REACT-1` | committed + server live, **needs a build** |
| 4 | `NOTIF-SYNC-1` only | committed; rest NOT started — see below |

### Phase 4 — what is done and what is deliberately not

**Done:** `NOTIF-SYNC-1` — a chat read on one device clears its notification on
the user's other devices.

**Not started, and each for a stated reason rather than for lack of time:**

- **Conversations section (Android 11+) + priority conversations + bubbles.**
  Needs a long-lived sharing shortcut published per chat via
  `ShortcutManagerCompat.pushDynamicShortcut`. `flutter_local_notifications`
  exposes `shortcutId` for *consuming* one but has no way to *publish* one, so
  this is ~40 lines of Kotlin. With no local toolchain, native code cannot be
  compile-checked here at all — it deserves its own pass, not a tail-end guess.
- **Inline photo/video thumbnails.** `MessagingStyle.Message` takes a
  `dataMimeType` + `dataUri`, but AvaTOK's DM media is encrypted at rest, so the
  notification path would have to run `MediaService.downloadAndDecrypt` inside
  the background isolate — where drift is closed and the account scope has to be
  rebuilt by hand. Real work, not a parameter.
- **@mentions piercing a muted group.** Needs mention parsing server-side; no
  mention model exists in the message envelope today.
- **Hide message content on the lock screen.** Small, but it needs a Settings
  toggle to be meaningful, and inventing a settings row unprompted is scope the
  owner did not ask for.
- **Launcher badge audit.** Read-only investigation; see the badge caveat below.

Not yet done, and both are required before any of this reaches a phone: the
worker + consumers deploy to production, and an Android build. Neither has been
run — the owner has not asked for a build, and the repo forbids triggering one
unprompted.

### Phase 1 is UNVERIFIED, not proven (checked in PostHog 2026-08-17)

Build 10564 is on the owner's phone and does contain the work — confirmed by
checking the commit is an ancestor of that build's sha, not by assuming. But
**not one notification has been drawn on it.** The last `push_shown` was 01:59
on build 10561, before this code existed, and `push_summary_shown` /
`push_stacked_failed` have never been ingested even once.

Why: in the 06:19–06:21 exchange the owner was the SENDER, and on the receiving
device every message produced `fcm_fg_received` immediately followed by
`push_fg_banner_suppressed` — the app was open on that exact thread, so the
banner was suppressed by design. The absence of `push_stacked_failed` means
nothing crashed either; the path simply has not executed.

**To verify:** AvaTOK fully closed or the phone locked, and **two different
people** messaging. One sender cannot produce a bundle, and reading the thread
suppresses the notification.

### Known gaps carried into Phase 2

- The launcher badge is bumped *before* the duplicate check, so a duplicate FCM
  delivery still inflates the count by one even though the shade correctly
  ignores it. Pre-existing ordering in `_showMessageNotif`; fixing it means
  moving `_bumpBadge` below the dedup, which touches the legacy path too.
- Turning `notifMessagingStyle` off does not retro-cancel notifications already
  posted at 8900+; they age out normally.
- The shade log is a read-modify-write blob shared by two isolates, so two
  messages landing in the same instant can lose one line from the *expanded*
  card. The notification itself is unaffected.
**Issue id prefix:** `[NOTIF-PARITY-n]`

---

## 1. What the owner asked for

| Pic | Ask | Today |
|---|---|---|
| 1 | An AvaTOK glyph in the status bar next to the clock when a message arrives (double round circle, capital **A** inside) | No notification icon exists. Every AvaTOK notification uses `@mipmap/ic_launcher`, which Android silhouettes into a **white blob** |
| 2 | Pull down → see the message, expand to read it in full without opening the app, with suggestion pills (Okay / Thanks) and Reply / Mark as read / Mute | One shared banner, `BigTextStyle`, first 140 chars, **no actions at all**, tap goes to the app home not the chat |
| 3 | "X reacted 😂 to your message" | **Nothing is sent** — reactions are a live socket frame only, no push, no notification |
| 4 | Several chats **stacked into one AvaTOK bundle** — "3 messages from 3 chats" with a `3 ⌄` chevron, one row per chat with its avatar, and each row individually expandable without opening the app | Impossible today: all chats share notification id `8000`, so the second message **replaces** the first. There is only ever one row, and it cannot be expanded per chat |
| — | "there must be more WhatsApp features I don't know about" | Section 3 |

---

## 2. Why it looks the way it does now (verified in code, 2026-08-17)

- `app/lib/push/push_service.dart:1311` `_showMessageNotif` — **one hardcoded notification id `8000` for every chat**. A message from a second person overwrites the first in place. No grouping, no summary.
- Same function, line 1361 — `BigTextStyleInformation` only, and only when the server sent a `preview`. No `MessagingStyle`, no `Person`, no sender avatar.
- `push_service.dart:182` / `:3161` — `AndroidInitializationSettings('@mipmap/ic_launcher')`, and **no `icon:` is ever passed** to any `AndroidNotificationDetails`. No `ic_notification` asset exists anywhere in the repo. No `default_notification_icon` meta-data in the manifest.
- Only two `AndroidNotificationAction` sites exist and both are call-related (`:1510`, `:1563`). **Zero `RemoteInput` anywhere in the repo.**
- `_onNotifTap` (`:286`) — payload is the literal string `'chat'`; it does `popUntil(isFirst)`. The `conv` id **is already in the FCM data** (`consumers/src/fcm.ts:826`) but is thrown away.
- Reactions: `worker/src/routes/messaging.ts:1121` `fanReactionEvent` — socket frame only, no `Q_PUSH.send`, no branch in `consumers/src/fcm.ts buildPayload`.
- `worker/src/routes/config.ts` DEFAULTS has **no notification flags at all**.

**One large piece of good news:** every push is already **data-only** (`consumers/src/fcm.ts:862` sends `message.data` with no `notification` block). The client owns 100% of rendering, so all of this is achievable **without changing the FCM transport** — only new `data` keys and new client code. There is also a working in-repo template for grouping: the missed-call summary at `push_service.dart:1257-1307`.

---

## 3. The full WhatsApp notification feature list

Everything WhatsApp does in the Android shade. **P0** = the owner's three asks, **P1** = he'll notice it's missing, **P2** = polish.

| # | Feature | Pri | AvaTOK today |
|---|---|---|---|
| 1 | Monochrome status-bar small icon | **P0** | ✗ white blob |
| 2 | One notification **per conversation** | **P0** | ✗ single id 8000 |
| 3 | `MessagingStyle` + `Person` + sender avatar photo | **P0** | ✗ |
| 4 | Expand to read the full message + the earlier unread messages in that chat | **P0** | ~ first 140 chars only |
| 5 | Group + summary bundle ("5 messages from 3 chats") | **P0** | ✗ (exists for missed calls only) |
| 6 | Tap deep-links into that exact thread | **P0** | ✗ goes to home |
| 7 | **Direct reply** — type and send from the shade | **P0** | ✗ |
| 8 | **Suggested reply pills** (Okay / Thanks) | **P0** | ✗ |
| 9 | **Mark as read** action | **P0** | ✗ |
| 10 | **Mute** action | **P0** | ✗ |
| 11 | **Reaction notifications** | **P0** | ✗ nothing sent |
| 12 | Notification disappears when you read the chat on another device | P1 | ✗ |
| 13 | Photo/video/sticker **thumbnail inline** in the shade | P1 | ✗ "📎 Attachment" |
| 14 | Group chats show *sender* inside *group name* | P1 | ✗ sender only |
| 15 | Muted chat → silent notification, still visible | P1 | ✗ mute state not consulted at all |
| 16 | Group **@mentions still notify** even when the group is muted | P1 | ✗ |
| 17 | Launcher **badge count** matches unread | P1 | ~ `BadgeService` exists — needs an audit |
| 18 | Conversations section at the top of the shade (Android 11+ long-lived shortcuts) | P1 | ✗ |
| 19 | **Priority conversation** (bypasses Do Not Disturb) | P2 | ✗ (falls out of #18) |
| 20 | **Bubbles** / floating chat heads | P2 | ✗ |
| 21 | Per-chat custom notification tone / vibration | P2 | ✗ |
| 22 | "Hide message content on lock screen" privacy setting | P2 | ✗ |
| 23 | Unread-message **reminder** (re-notify after N min) | P2 | ✗ |
| 24 | Failed-to-send notification | P2 | ✗ |
| 25 | Poll / event / group-invite notifications | P2 | ~ group invite only |

---

## 4. Feasibility check (done, not assumed)

`flutter_local_notifications 17.2.3` — already in `pubspec.yaml` — **supports everything in P0**:

- `MessagingStyleInformation(Person, conversationTitle:, groupConversation:, messages: [Message(...)])` ✓
- `Person(name:, icon:, key:, important:)` ✓ (avatar via `AndroidBitmap`)
- `AndroidNotificationAction(..., inputs: [AndroidNotificationActionInput(label: 'Reply')])` — this **is** `RemoteInput` ✓
- `AndroidNotificationDetails.shortcutId` ✓ (the Conversations-section hook)

**Two traps found:**

1. `allowGeneratedReplies` **defaults to `false`** in this plugin (verified in the constructor signature). The Okay/Thanks pills the owner wants are Android's on-device Smart Reply — they will **never appear** unless we explicitly set `allowGeneratedReplies: true` on the reply action. They also require `MessagingStyle` **and** a RemoteInput action to both be present, and are OEM/Android-version dependent. **Mitigation:** also ship our own `AndroidNotificationActionInput.choices` list, which renders as chips on every device and is not OEM-dependent.
2. Publishing the **long-lived sharing shortcut** (#18/#19/#20) is *not* exposed by the plugin — only consuming `shortcutId` is. That needs ~40 lines of Kotlin (`ShortcutManagerCompat.pushDynamicShortcut`). This is why it sits in Phase 4, not Phase 1.

---

## 5. The plan

### Phase 0 — foundations (nothing else can ship without these)

| id | Work | Where |
|---|---|---|
| `NOTIF-ICON-1` | Monochrome notification icon: double circle + capital **A**, pure white on transparent, 5 densities → `app/android-res/drawable-{m,h,xh,xxh,xxx}dpi/ic_notification.png`. Add `com.google.firebase.messaging.default_notification_icon` + `default_notification_color` meta-data to the manifest, and pass `icon: 'ic_notification'` on every `AndroidNotificationDetails`. | `app/android-res/`, `AndroidManifest.xml`, `push_service.dart` |
| `NOTIF-PAYLOAD-1` | Enrich the `notify` push data block: `msgId`, `ts`, `senderAvatarUrl` + `senderAvatarVersion` (copy the pattern already used for calls at `fcm.ts:671`), `isGroup`, `groupName`, `convTitle`. Old clients ignore unknown keys → zero risk. | `consumers/src/fcm.ts:756-828`, `worker/src/routes/messaging.ts:315` |
| `NOTIF-FLAGS-1` | Declare `notifMessagingStyle`, `notifDirectReply`, `notifReactions`, `notifConversationShortcuts`, `notifAutoDismissOnRead` in the `PlatformConfig` interface **and** `DEFAULTS` in the same commit, plus `RemoteConfig` getters. Prove each with a `flags.sh set` that does not 400. | `worker/src/routes/config.ts`, `app/lib/core/remote_config.dart` |
| `NOTIF-STORE-1` | Per-account, per-conversation store of the messages currently shown in the shade (needed to rebuild the `MessagingStyle` thread on the next push, from the background isolate). Must use `scopedKey(...)` — shared-phone rule. | `app/lib/push/` + `core/account_storage.dart` |

### Phase 1 — the shade (pics 1 and 2, the reading half)

`NOTIF-STYLE-1`

This is the phase that produces pic 4 — the stacked bundle. The three sub-parts are inseparable: you cannot get a stack without one notification per chat, and you cannot expand a row individually unless that row is its own notification.

- **Stable per-conversation notification id**: `8200 + (hash(conv) % 600)`, replacing the single hardcoded `8000`. This alone is what turns one replaced banner into N stacked rows.
- **`MessagingStyleInformation`** with `Person(name, icon: avatar)` per child; avatar pulled through the existing `avatar_cache.dart` pipeline (`/cdn-cgi/image/...`), with a graceful no-avatar fallback. Each child expands on its own chevron to show that chat's unread messages in full — the owner's "expand individual messages without opening the app".
- Group chats: `conversationTitle: groupName`, `groupConversation: true` → renders as *"AvaGlobal · Satish Mumbai: Yes sounds good"*, matching pic 4 row 2.
- **`groupKey: 'avatok_messages'` + a group-summary notification** carrying `setAsGroupSummary: true` and `InboxStyleInformation` with the *"N messages from M chats"* line and one line per chat. Clone the working missed-call implementation at `push_service.dart:1270-1307` — it already does exactly this shape for calls.
- Summary bookkeeping: the "N messages from M chats" counts come from `NOTIF-STORE-1`, and the summary must be cancelled when the last child is dismissed or read, or Android leaves an empty bundle behind.
- Tap deep-link: put `conv` into the notification `payload` and route `_onNotifTap` to the thread — a tap on a *child row* must open that chat, not the app home.

### Phase 2 — actions and pills (pic 2, the acting half)

`NOTIF-REPLY-1`, `NOTIF-ACTIONS-1`

- **Reply** action with `inputs: [AndroidNotificationActionInput(label: 'Reply', choices: ['Okay','Thanks','👍'])]` and `allowGeneratedReplies: true`, `showsUserInterface: false`, `cancelNotification: false`.
- Background send path: handle the reply in the notification-response isolate, post the message, then re-render the notification with the sent message appended (WhatsApp's exact behaviour). **This is the highest-risk item in the plan** — the isolate has no app state, so it needs its own auth token load and its own send call.
- **Mark as read** — clears unread server-side and cancels the notification.
- **Mute** — mutes the thread for 8h; muted threads then post at `Importance.low`, silent.

### Phase 3 — reactions (pic 3)

`NOTIF-REACT-1`

- Server: new `kind: "reaction"` enqueued from `fanReactionEvent` (`messaging.ts:1121`), addressed **only to the author of the reacted-to message**, carrying the emoji and a snippet of the original text. Respect mute.
- `buildPayload` branch → `type: "reaction"`.
- Client: renders inside the *same* conversation notification as a line — "Dhyani reacted 😂 to: Yes that's working" — so reactions never fight the message notification for shade space.

### Phase 4 — conversation space and polish

`NOTIF-SHORTCUT-1` (Kotlin shim → long-lived shortcuts → Conversations section, priority conversations, bubbles), `NOTIF-MEDIA-1` (inline photo thumbnails), `NOTIF-SYNC-1` (silent `notif_clear` push when read elsewhere — copy the existing `del`/`hide` silent-push pattern at `fcm.ts:829`), `NOTIF-BADGE-1` (badge audit), `NOTIF-PRIVACY-1` (hide-preview-on-lock-screen setting), `NOTIF-MENTION-1` (@mentions pierce a muted group).

---

## 6. Repo-specific traps that will bite

1. **No local Flutter toolchain** (deleted 2026-08-05). Every Dart typo costs a 40–80 min CI round trip. Keep each commit to one small file.
2. **Fake-flag rule.** A flag the client reads but `config.ts` DEFAULTS does not declare can never be flipped. Declare interface + DEFAULTS in the same commit, then prove with `flags.sh set`.
3. **`app/android-res/` is the icon source CI ships.** Editing `app/android/app/src/main/res/mipmap-*` only changes what you see locally.
4. **`tool/postcreate.py` rewrites the manifest in CI.** Verify the icon meta-data against the *merged* manifest, never the source.
5. **Design guard.** No raw colour literals, Phosphor icons only under `features/**`. Run `python3 tool/check_design_guard.py --check all`.
6. **Ship gate.** Each `NOTIF-*` id needs a `tool/ship_manifest.json` entry with a success assertion *before* the build goes out. Notifications are two-sided → **two phones on the same newest build**, or the result is untestable by construction.
7. **Worker deploys are production here.** `npx tsc --noEmit` in `worker/` first, commit before deploying, and `git status` on `worker/` must be clean.

---

## 7. How we prove each phase worked (ship-gate rule 3)

Existing telemetry is healthy — `push_shown`, `fcm_bg_handled`, `push_notif_tapped`, `push_fg_banner_shown` are all flowing (last 14 days, ~5-6 devices). We extend it rather than inventing a parallel scheme.

| Phase | Success value to read in PostHog — not "events are flowing" |
|---|---|
| 1 | `push_shown` with `style='messaging'` **and** `grouped=true`, from **≥2 distinct persons** on the newest `$app_build` |
| 1 | A `push_summary_shown` carrying `chats>=2` — i.e. the bundle in pic 4 actually formed, rather than one chat overwriting another |
| 1 | `push_notif_tapped` with `dest='thread'` (today it would be `dest='home'`) |
| 2 | `notif_action` with `action='reply'` **and** `sent=true` — the send succeeding is the assertion, not the tap |
| 2 | `notif_smart_reply_shown=true` on at least one device, else fall back to our own `choices` |
| 3 | `push_shown` with `type='reaction'`, on the **message author's** device, tagged with both emails |
| all | Zero `$exception` growth on `push_service.dart` after the build lands |

Every event carries the user's email (and both parties' emails where the event has them), per the project telemetry rule.

---

## 8. Owner decisions (2026-08-17)

1. **Icon** — I design the double-circle-A glyph, preview before it lands.
2. **Order** — Phase 0 → Phase 1 first (icon, per-chat stacking bundle, sender photos, expand-to-read). Then 2, then 3, then 4.
3. **Reactions** — notify on **every** reaction, in 1:1 and groups alike, foreground or background. No throttling. If the shade gets noisy in practice, the mute action from Phase 2 is the escape hatch and we can revisit.

### Still open

- **Reply from the shade** — should sending a reply also mark the chat read (WhatsApp does), or leave it unread? Defaulting to *mark read* unless told otherwise.
