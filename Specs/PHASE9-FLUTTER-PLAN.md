# Phase 9 — Social apps (Flutter) — plan + what's wired

_v5.2 §26 Phase 9. The backend (Phases 0-8) is live; this phase puts the products
on it. **Constraint:** APK build / CI / on-device testing happen on your build
machine — not in this environment — so this session delivers the client **wiring +
the Agent Inbox screen + a precise execution plan**, not compiled/tested APKs._

## Done in this session (committed)

- **`lib/core/platform_api.dart`** — a typed Dart client for every v5.2 endpoint:
  AvaID (`idSession/idResult/idStatus`), Wallet (`walletBalance/walletTopup/
  walletSpend/walletTransactions/walletEarnings/walletLiveUrl`), Calendar
  (`createSlot/slots/book/cancelBooking/events`), Payout (`payoutSetup/
  payoutAccounts/payoutRequest/payoutStatus`), OLX (`olxBrowse/olxCreate/
  olxUploadFile/olxBuy/olxRefund/olxDownloads/olxDownloadPath`), Agent
  (`personas/savePersona/converse/inbox/inboxItem/inboxAction/agentTask/ttsListen/
  agentAudioUrl`). All go through the existing `ApiAuth` NIP-98 signer.
- **`lib/core/api_auth.dart`** — added `putJson`, `deleteSigned`, `getBytes`.
- **`lib/core/config.dart`** — added `kIdBase/kWalletBase/kCalendarBase/
  kPayoutBase/kOlxBase/kAgentBase` (all on `avatok.ai` infra host).
- **`lib/features/avabrain/agent_inbox_screen.dart`** — the AvaBrain 5th screen:
  per-app color-coded inbox, Connect/Book/Approve-purchase/Dismiss actions, 1-hour
  Undo for auto-approved items, and lazy "Listen" (calls `ttsListen`).

## Remaining client work (execution order)

### A. AvaBrain standalone app — 5 screens
1. **Chat** — `BrainApi.ask()` Q&A.
2. **Briefing** — `BrainApi.briefing()`.
3. **Memory** — `BrainApi.entities()` + delete (forget).
4. **Investigate** — `BrainApi.investigate()`.
5. **Agent Inbox** — ✅ built (`agent_inbox_screen.dart`); add it to the AvaBrain
   nav. Wire an audio player (`just_audio`) to `agentAudioUrl()` using a NIP-98
   header (use `ApiAuth.getBytes` to fetch then play from bytes/temp file, since
   the stream route is auth-gated).

   Persona editor: a small form per app → `PlatformApi.savePersona()`; show the
   `moderation` result (422 = unsafe, not active).

### B. AvaChat / AvaTok rename refactor (client-side only, no backend change)
- The current combined app is "AvaTok". Rename the messaging surface to **AvaChat**
  and shrink **AvaTok** to 1:1 video. This is nav/label/icon work in
  `lib/shell/ava_shell.dart` + `lib/features/avatok/` — endpoints are unchanged.

### C. Tier-2 social apps (each: brain hook + agent hook)
AvaTweet, AvaBook, AvaGram, AvaLinked, AvaTube, AvaLive, AvaDate, AvaMatri, AvaOLX.
- Gate entry on verification: call `PlatformApi.idStatus()`; if `tier != 'verified'`
  route to the **AvaID** flow (see D) before allowing list/sell/post.
- **AvaLive** creates its OWN Cloudflare Stream live inputs on demand (none exist —
  Phase 0 cleared the old spitube inputs). Add a "create live input" call when a
  creator goes live (server route for this lands with the AvaLive build).
- **AvaDate/AvaMatri** are agent-powered: persona editor + `converse()` + the Agent
  Inbox surface above. Gift/spend flows use `walletSpend()`.
- **AvaOLX** UI: browse (`olxBrowse`), create listing + `olxUploadFile` for digital,
  `olxBuy` → `olxDownloads`/download, `olxRefund` within 24h.

### D. AvaID liveness — native Amplify bridge (Phase 0.4 decision)
- Add a Flutter `MethodChannel('avatok/liveness')`.
- **Android** (`MainActivity.kt`): integrate `com.amplifyframework:aws-auth-cognito`
  + the Face Liveness UI (`FaceLivenessDetector`), driven by the `SessionId` from
  `PlatformApi.idSession()`; on completion call `PlatformApi.idResult(sessionId)`.
- **iOS** (`AppDelegate.swift`): Amplify Swift `FaceLivenessDetectorView`.
- Server is ready (`/api/id/*`), but returns 503 until AWS creds are set — gate the
  UI on `idStatus().rekognition_configured`.

### E. Wallet/Calendar/Payout UI
- Wallet: balance (poll `walletBalance` or connect `walletLiveUrl` WebSocket),
  transactions list, top-up (shows the server's "pending legal" 503 until enabled).
- Calendar: slot creation (creators), booking flow (debits wallet if paid).
- Payout: bank-link form + request (shows "pending legal" 503 until enabled).

## Build & test (your machine / CI)
`flutter pub get && flutter build apk` then on-device smoke per app
(login → core flow). The existing `.github/` CI builds the APK.

## Status
Client gateway + Agent Inbox screen committed and consistent with the deployed
backend contract. The remaining screens are straightforward `PlatformApi`/`BrainApi`
consumers; no backend changes are required to build them.
