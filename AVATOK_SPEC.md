# AvaTok — Feature & Flow Spec (build contract)

**Positioning:** Free, WhatsApp-style 1:1 messaging + voice/video calls, on Nostr.
**Free/paid line:** AvaTok = 1:1 only, free (WebRTC P2P + Cloudflare TURN). Group *chat* is free; group *calls* live in **AvaConsult** (paid SFU). Broadcast lives in **AvaLive** (paid).

Decisions locked:
- **Contacts:** npub / @handle (NIP-05) / QR + invite link. No phone directory.
- **Incoming call:** native CallKit / ConnectionService (`flutter_callkit_incoming`) — true lock-screen call UI.
- **Encryption:** 1:1 messages E2E via MLS (per architecture principles).

---

## 1. Identity & contacts

Identity = the user's **npub**. People connect by:
- **AvaTOK ID / @handle (NIP-05)** — e.g. `@maya` resolves to an npub via `avatok.ai/.well-known/nostr.json`.
- **npub paste** — raw `npub1…`.
- **QR code** — show mine / scan theirs (encodes npub).
- **Invite link** — `avatok.ai/i/<npub>`; share via any app. New installs land pre-connected.

### Add-contact sheet (from the `+` in the people row — matches the mockup)
Bottom sheet titled **"Add contact"** with two segmented tabs:
- **Add by ID** (default): input `Enter user ID, @handle or npub…`, primary **Add contact** button (disabled until input is non-empty/valid). Helper: *"Paste a friend's AvaTOK ID, @handle, or Nostr npub."*
- **Search site**: search the AvaTOK public directory by handle/display name → tap a result to add.
- QR scan accessible via an icon in the input row (scan their code) + a "My QR" affordance.

Resolution order on submit: `@handle` → NIP-05 lookup; `npub1…` → decode directly; else treat as AvaTOK ID. On success the person is added to the chat list; on miss → "No one found — send them an invite link instead."

---

## 2. Chat list (home of AvaTok)
- Header: ☰ menu · **AvaTOK** wordmark · add-person icon · avatar.
- Search bar: *"Search people on AvaTOK."*
- Horizontal people row: first chip is **Add** (dashed `+`, opens the sheet above), then recent/active contacts with online dots.
- Conversation list: avatar, name, last-message preview, time, unread badge, online dot.
- Tabs (bottom): **Chats · Calls**.

## 3. Conversation (1:1)
Text, voice notes, photos/short video (small media → Blossom-signed), reply, forward, delete (me / everyone), read receipts, typing indicator, **message request** gate for first contact (anti-spam). Header shows name + presence and **voice / video call** buttons. All E2E via MLS.

## 4. Calls
- **Outgoing:** tap call in a chat → ring the callee.
- **Incoming (WhatsApp-exact):** FCM high-priority wake → native full-screen call UI even when locked/killed: caller avatar+name, "AvaTok voice/video call", **Accept (green) / Decline (red)**, ringtone+vibrate.
- **Accept** → P2P connect (WebRTC + Cloudflare TURN) → in-call screen (mute / speaker / video toggle / flip cam / end).
- **Decline** → caller sees "Declined". **No answer (~30s)** → "Missed call" + entry in Calls tab and the chat.
- **Calls tab:** history (missed/incoming/outgoing), tap to call back.
- **Audio-only calls send audio only** (no video track) — cost rule.

## 4b. Media in chat & calls
- **Send files / images / videos** in chat — each **capped to a size two peers can move over P2P** (target cap ~16 MB; tunable).
- **Storage (free tier included) — REVISED:** all **messages and media are stored** so chats keep full history, sync across devices, and deliver to offline peers. Media is **content-hashed via a Worker** (Blossom-style, on R2); **MLS secures transport**. *Live call audio/video streams stay pure P2P and are never recorded* — storage applies to chat content (text, voice notes, clips, images, files), not the live call.
- **Adaptive video:** auto-detect bandwidth and step video resolution up/down with link speed.
- **Resilient upload:** failed or cut-off transfers get a **Retry**; retry fires an FCM push that **wakes the other side** to resume/receive.

## 4c. Live effects & recording
- **Emoji reactions with sound** — in chat *and* during a video call, sending an emoji plays a matching sound (👏 → clap, etc.) for both sides.
- **Voice message:** record audio in a chat and send it as a voice file.
- **Short video clip:** record a clip in a chat; when the length cap is hit, **recording auto-stops and the clip is sent**.

## 4d. Bubble interactions (long-press)
Press-and-hold any bubble / image / file / video → context menu:
- **React** — like ❤ or pick an emoji (shows on the bubble).
- **Forward** — to another contact (or group).
- **Delete for me** — removes locally.
- **Delete for everyone** — removes on both ends.

## 4e. Conversation header overflow (⋮)
Three-dots menu in the thread header: **Delete chat · Archive chat · Block user** (in addition to the voice/video call buttons).

## 4f. Groups (chat only)
Create a group, add members from contacts, group messaging + media. **No group video calls** in AvaTok (paid group calls live in AvaConsult).

## 5. Settings entry (inside AvaTok)
Profile (display name, @handle, avatar), presence/last-seen toggle, blocked list, plus the account-level Backup / Manage keys / Delete (already in Settings).

---

## Screen inventory (build order)
1. **Chat list** + people row + Add-contact sheet (+ search).
2. **Conversation** thread (text first, then voice notes/media).
3. **Incoming call** (CallKit) + **in-call** screen.
4. **Calls tab** (history).
5. Profile / contact detail.

## Backend pieces this needs
- NIP-05 directory on `avatok.ai/.well-known/nostr.json` (handle → npub) + a search endpoint.
- Invite-link resolver (`/i/<npub>`).
- CallKit token + FCM call-push (mostly in place via `/call`); add decline/timeout signaling.
- MLS group state for 1:1 (key packages on relay).
