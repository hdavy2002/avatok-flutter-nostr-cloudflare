# AvaTok — Session Handoff (resume point)

Use this to start a fresh chat cheaply. Source-of-truth docs: `AVATOK_SPEC.md`,
`ARCHITECTURE_PRINCIPLES.md`, `ROADMAP.md`. Repo: `hdavy2002/avatok-flutter-nostr-cloudflare`.

## What AvaTok is
Flutter/Android decentralized creator super-app on Nostr. **AvaTok = free 1:1**
messaging + voice/video (WebRTC P2P + Cloudflare TURN). **AvaLive** = paid broadcast
(CF Stream Live). **AvaConsult** = separate paid 1:20 app (RealtimeKit SFU, separate
binary — RealtimeKit + flutter_webrtc crash together).

## Locked decisions
- Calling is **1:1 only**. **Groups = messaging only, no calls** (avoids SFU cost). SFU code removed from app.
- Contacts: npub / @handle (NIP-05) / QR + invite link. No phone directory.
- Incoming calls: native **CallKit** (`flutter_callkit_incoming` pinned **2.5.8** — 3.x API differs).
- Messages + media **stored**; media **AES-256-GCM encrypted client-side**, content-hashed → R2 (server holds ciphertext only).
- Encryption reality: 1:1 → NIP-44 is the target (real E2E from Nostr keys); **MLS has no Dart lib** (OpenMLS FFI = future milestone). Today media uses AES-GCM with locally-held keys.
- Build only on **GitHub Actions**, never on the Mac. Domain **avatok.ai**, reuse existing Clerk tenant.

## Build / deploy
- CI: `.github/workflows/android.yml` → `flutter create` → `app/tool/postcreate.py` patches android → `flutter build apk` → publishes to release tag **calltest-latest**.
- APK: https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/releases/download/calltest-latest/avatok-call.apk
- **compileSdk 36** (media plugins need it). minSdk 24.
- Push from sandbox fails (no GH auth); commit+push via **Desktop Commander** on host. Clear `.git/*.lock` first (FUSE leaves them).
- Worker deploy: `cd signaling && CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy`. CF token is in-session only (account `fd3dbf43f8e6d8bf65bd36b02eb0abb0`). CF token can do R2+Workers but **not** Calls/Realtime SFU.

## Backend (Cloudflare Worker: avatok-call-signaling.getmystuffme.workers.dev)
`signaling/src/index.ts` routes: `/ice` (STUN+TURN), `/register` + `/call` (FCM v1 wake),
`/room/:id` (WS DO signaling), `/profile` `/resolve` `/search` (NIP-05 directory, KV),
`/media` POST+GET (R2 `avatok-media`, sha256 content-addressed), `/sfu/*` (CF Realtime proxy,
**gated/dormant** — unused now that groups have no calls). FCM/TURN/service-account are Worker secrets.

## App structure (app/lib)
- `main.dart` RootFlow: loading→welcome→signIn→onboarding→shell.
- `auth/clerk_client.dart` hand-rolled Clerk FAPI REST (SDK was broken).
- `features/onboarding/*` 6-step flow. `core/apps.dart` 15-app registry. `core/onboarding_store.dart`.
- `shell/ava_shell.dart` + `ava_sidebar.dart` + AvaExplore landing.
- **AvaTok** `features/avatok/`: `chat_list.dart` (Chats·Calls bottom tabs, add-contact, groups entry),
  `add_contact_sheet.dart`, `contacts.dart` (ContactsStore + Directory client), `chat_thread.dart`
  (bubbles, media send photo/video/file, voice record, long-press react+sounds/forward/delete, ⋮ overflow),
  `calls_screen.dart` (history), `new_group_screen.dart`, `media.dart` (AES-GCM encrypt+upload),
  `call_screen.dart` (1:1 WebRTC P2P), `data.dart`.
- `push/push_service.dart` CallKit incoming + FCM + `registerToken`. `navigatorKey` global.
- Reaction sounds: `app/assets/sounds/*.wav` (self-authored CC0).

## Built & green (on-device testing pending)
Onboarding, sidebar, AvaExplore, Settings (backup/keys/delete UI), add-contact + directory,
1:1 chat + media (photo/video/file/voice, encrypted, retry), reactions+sounds, groups (chat),
Calls tab, CallKit incoming UI, 1:1 P2P call screen, AvaLive WHIP/WHEP.

## Pending / next
- **Real call signaling end-to-end**: make `/call` FCM + room handshake actually ring the
  other phone and connect on answer (currently call screen joins a room but no real callee ring loop tested).
- NIP-44 real E2E for 1:1 (replace local AES key handling). MLS-for-later.
- Backup export backend (email download link), contacts upload backend (both UI-stubbed).
- AvaLive live-events discovery screen. AvaVerse/AvaLibrary. Other 12 apps still `ComingSoon`.
- Verify CallKit accept-from-locked/killed across OEMs on device.

## Gotchas hit
- `record` 5.x broke build (record_linux mismatch) → use **7.0.0**.
- `flutter_callkit_incoming` 3.x API rewrite → pin **2.5.8**.
- Media androidx libs need **compileSdk 36**.
- Firebase service-account JSON is secret (gitignored); never commit.
