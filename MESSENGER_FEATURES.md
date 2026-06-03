# AvaTok — Messenger Feature Map (WhatsApp-parity)

Legend: ✅ done · ★ requested now · ○ recommended · ‼ essential gap

## Already shipped ✅
- 1:1 chat, **E2E** (NIP-44 + NIP-17 gift wrap, metadata-private)
- Media: photo / camera / video clip / file / voice — encrypted on R2, retry on fail
- Playback: image in-bubble, video fullscreen, voice play/pause
- Emoji **reactions + sounds**; long-press **forward / delete-for-me / delete-for-everyone**
- **Typing** indicator + **read receipts** (1:1, blue double-check); group typing
- Calls: 1:1 voice/video (P2P), native **CallKit** incoming, **ringback / decline / busy / no-answer**
- **Call history** (real)
- Groups: create, **fan-out E2E messaging**, media, **add / remove / leave** member management
- AvaLive broadcast + **discovery**
- **Backup** export; **Profile / @handle**, directory search, add by ID / invite
- Onboarding, key save, settings

## Requested now ★
1. **Group roles / admin** — admin-only add/remove/rename; creator is admin; promote/demote.
2. **Reply-to / quoted messages** — swipe or long-press → reply; quoted preview in the bubble.
3. **Unread badges from real messages** — chat-list badge counts actual unread; clears on open.

## Essential gaps ‼ (needed to feel like WhatsApp)
- ‼ **Message push notifications** — right now only *calls* wake the phone; new **messages are silent** when the app is closed. Without this, you miss messages. (Needs a per-message FCM nudge + a notification.)
- ‼ **Real block / archive / mute** — these are UI stubs today. Block should stop their messages; archive/mute should actually hide/silence.

## Recommended next ○
- ○ **Status / Stories** (24h ephemeral posts) — a whole WhatsApp pillar
- ○ **Disappearing messages** (per-chat timer)
- ○ **Edit sent message** + "Edited" label; **"Forwarded" label**
- ○ **Star / bookmark** messages; **pin** chats & messages
- ○ **Search** within a chat + global search
- ○ **Per-chat mute / notification settings**
- ○ **Mentions (@)** in groups; **group description / icon / invite link**
- ○ **Contact profile view** (their @handle, npub, shared groups) + **safety-number / QR verify**
- ○ **Delivered** state (we have sent + read; add the middle tick)
- ○ **Last seen / online** (privacy-controlled)
- ○ **Drafts**, **wallpaper/theme**, **location share**, **contact card share**, **polls**, **GIF/stickers**

## Suggested build order
1. Reply/quote + unread badges (pure client, low risk)
2. Group roles/admin
3. ‼ Message push notifications (the real "messenger" unlock)
4. Real block/archive/mute
5. Status/Stories, then the rest of ○
