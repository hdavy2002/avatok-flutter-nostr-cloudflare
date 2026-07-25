# Root-cause report — 10 recurring production issues

**Date:** 2026-07-25
**Environment:** PRODUCTION (`.avatok-target = prod`)
**Code state:** `main` @ `336e1b0`
**Device under investigation:** `hdavy2002@gmail.com`, app `0.1.18`, build **10462** (= live `latestAppBuild`; the newer mobile build is still approval-gated)
**Evidence sources:** live prod effective flags read through `scripts/flags.sh` on 2026-07-25, earlier PostHog evidence in Parts I/V, repo at `336e1b0`, graphify code graph. The PostHog connector was unavailable for the Part XI reconciliation, so no post-deploy user event was claimed.

## Table of contents

1. **Part I — Original production root-cause report (§0–§9)**
2. **Part II — Free text chat and metered multimodal implementation spec (§10–§14)**
3. **Part III — Independent billing/config audit of Part II (§15–§21)**
4. **Part IV — Stability-first AvaBrain product plan (§22–§28)**
5. **Part V — AI latency and fast-response plan (§29–§35)**
6. **Part VI — Media jobs, file actions and AvaBrain retrieval (§36–§42)**
7. **Part VII — Exact media implementation handoff (§43–§50)**
8. **Part VIII — Verified billing/flag implementation baseline (§51–§56)**
9. **Part IX — Review and amendments to the implementation baseline (§57–§63)**
10. **Part X — Final review, interim production decision and closure tests (§64–§68)**
11. **Part XI — Post-ship reconciliation and remaining permanent fixes (§69–§77)**

**Precedence:** Part XI records the source/live state after the billing wave and supersedes stale incident-status statements in Parts I/X. Part X amends Part VIII and Part IX; Part IX amends Part VIII; Part VIII supersedes conflicting instructions in Part III and Part II. Explicit `SUPERSEDED` markers in older sections are historical evidence, not implementation instructions.

> **SERVER FIX SHIPPED; USER CLOSURE STILL PENDING.** Production still has
> `aiWalletMeteringEnabled=true` and `betaFreePremium=false`, but `[AI-WALLET-SPENDABLE-2]`
> and the structural `FREE_CAPABILITIES` bypass are now in the deployed Worker. That flag
> combination no longer blocks `chat_ava`/`chat_thread` text server-side. Do **not** turn
> metering off as the old interim mitigation. However, build 10462 still contains the local
> Messenger `#ava`/`@ava` premium gate; its removal is in the newer approval-gated build.
> Ask Ava should work server-side now, but the incident is not closed until the production
> smoke/PostHog/wallet checks in §72 are recorded.

---

## 0. Executive summary

Ten reported symptoms. They are **not ten bugs**. They collapse into **four root-cause families**, and one of those families explains two of the loudest complaints at once.

| # | Symptom (pic) | Real cause | Family |
|---|---|---|---|
| 1 | Wallet is an empty black screen (1) | **Stale screenshot.** The redesign shipped and is live on build 10462 — telemetry proves it renders 30 chart points, 2 categories, 5 transactions | E — false alarm, but with a real reporting failure underneath |
| 2 | "#ava is a paid feature" (4) | `betaFreePremium` flipped **OFF** in prod + owner never topped up → client `_premium == false` blocks the send | **A — the AI money gate** |
| 3 | "Sorry, I could not find an answer" (7) | Server returned **HTTP 402** because `WalletDO.reserve()` checks **paid balance only** and ignores the 100-token welcome bonus. Client silently rendered the 402 as "no answer" | **A — the AI money gate** (+ D) |
| 4 | Media previews squeezed with green band (5,6) | Captioned/replied media falls into a hardcoded `width: 220` path instead of filling the bubble; no aspect ratio is ever persisted | B — layout |
| 5 | Back button lands on Inbox (8) | Inbox and AvaBrain each push a full-screen route onto the **same** Navigator with no mutual dismissal | B — layout/nav |
| 6 | Every inbox row green + orange dot (8) | `_unreadCount()` prioritises a local "heard" (pressed-Play) flag over the server's "read" flag | B — layout |
| 7 | Own avatar missing / reloads every time (9) | `_myAvatarUrl` loads async after first paint; cache key includes pixel size and the pre-warm only writes `px=192` while the bubble asks for `px=64` | B — layout/cache |
| 8 | Receptionist "Save" says "that doesn't look like a real name" (10) | The **availability note** is sent to the moderator tagged as `ModField.name`; the server's name regex rejects any sentence with a digit or >60 chars | C — copy-paste regression |
| 9 | "I spent 1 token and there is no accountability" | Accountability exists server-side, but the wallet's own diagnostic event is broken and balance events carry no balance | D — telemetry that can't see failure |
| 10 | "These keep coming back" | See §7. An audit written **the day before** (`Specs/AUDIT-MESSENGER-AI-MEDIA-UI-2026-07-24.md`) already named issues 2 and 3. It was never implemented, and a flag was flipped on top of it | F — process |

**The single highest-priority finding:**

> `aiWalletMeteringEnabled` is **`true`** in production. `betaFreePremium` is **`false`**.
> `WalletDO.reserve()` admits on `cur.balance` — **paid tokens only**.
> Every user whose tokens are the 100-token welcome bonus therefore has *effective* balance **0** for every AI call, and gets a 402 on every request.
> That is not "AvaBrain is broken." That is **AI is off for every free user in production, right now.**

---

## 1. Live production flag values

Read from `https://api.avatok.ai/api/config` with `Cache-Control: no-cache` + random cache-buster, 2026-07-25. **Not** from `DEFAULTS` in `config.ts` (199 keys returned).

| Key | `DEFAULTS` in code | **LIVE PROD** | Consequence |
|---|---|---|---|
| `aiEnabled` | true | **true** | AI is not kill-switched. Rules out the "ai_disabled" theory. |
| `betaFreePremium` | true | **false** | Every premium-AI gate is now live. Free users lose `#ava`, `@ava`, attachments. |
| `aiWalletMeteringEnabled` | **false** | **true** | The reserve/settle wallet path is **live**, not dark as the code comments claim. |
| `billingEnabled` | false | **false** | No subscription path exists to *become* premium. Top-up is the only route. |
| `mediaMemoryEnabled` | false | **true** | |
| `avaBrainVoiceBillingEnabled` | false | **true** | |
| `receptionistUseCf` | false | **false** | Receptionist is on the Gemini lane, not the DeepInfra CF lane. |
| `latestAppBuild` | — | **10462** | Matches the device. He is on the current build. |
| `webSearchEnabled` / `fileAnalysisEnabled` | false | **false** | |

**Three of these differ from `DEFAULTS`.** Two of them (`betaFreePremium=false`, `aiWalletMeteringEnabled=true`) are the direct cause of issues 2 and 3. Every source comment in `ai_billing.ts` that says *"while metering is off this is a no-op"* is **wrong in production**.

---

## 2. FAMILY A — The AI money gate (pics 4 and 7)

This is one bug wearing two faces.

### 2a. The proof, from the device's own telemetry

`hdavy2002@gmail.com`, 2026-07-24, build 10462:

```
15:44:52  ava_chat_gate_blocked                       <- pic 4, the "#ava is a paid feature" toast
16:04:24  askava_opened            (source=root)
16:04:31  ava_chat_request         (source=askava, premium=FALSE)
16:04:35  api_error                (status=402)       <- pic 7, message 1 "hi"
16:04:46  ava_chat_request         (source=askava, premium=FALSE)
16:04:48  api_error                (status=402)       <- pic 7, message 2 "meaning"
16:05:02  shellv2_askava_closed
```

Two sends, two 402s, `premium=false` on both. There is no ambiguity here.

### 2b. Face 1 — `#ava` in chat (pic 4)

`app/lib/features/avatok/chat_thread.dart:3232-3277`

```dart
if (privateAva || shared) {
  if (!_premium) {
    _capNote('Ava in chat is a paid feature — subscribe to get an Ava reply to #ava.');  // :3257
  } else {
    onSummonAva!(...);
  }
}
```

`_premium` is set at `chat_thread.dart:1095` from `MoneyApi.balance()['premium']`. Server-side (`worker/src/routes/wallet.ts:462-489`), `premium` is set by:

1. `betaFreePremium` → **now false in prod**, so this no longer grants it;
2. `sub.tier >= 1` → unreachable, `billingEnabled=false`;
3. `WalletDO.credit()` with `type: "topup"` (`worker/src/do/wallet.ts:225-227`) — a real money top-up, sticky forever.

Owner has never topped up ⇒ `premium = 0` ⇒ blocked. The literal text **is** still delivered to the peer (see the comment at `:3255-3256`) — only **Ava's reply** is suppressed, client-side, before `onSummonAva` is ever called. No tariff is consulted, no model is invoked, no token is spent. The paywall is an entitlement bit, not a price.

Note the gate never reads `spendable`. It doesn't matter that the wallet holds 95 tokens.

### 2c. Face 2 — Ask Ava / AvaBrain (pic 7) — the deeper bug

The request **does** reach the server (`ava_chat_request` fired, so `requireUser` passed). Then:

`worker/src/routes/ava_gemini.ts:293-310`
```ts
const reservation = await reserveAiJob(env, { uid, opId, capability: "chat_ava", modality: "text", model: chatModel, ... });
if (!reservation.ok) {
  return json({ error: reservation.error, needed: ..., balance: ..., timings: {...} }, 402);
}
```

Note: **the 402 body has no `answer` key.**

`worker/src/lib/ai_billing.ts:292+` → `walletOp(env, uid, { op: "reserve", amount, ... })`

`worker/src/do/wallet.ts` — `reserve()`:
```ts
const beta = await this.betaFree();          // FALSE in prod
const cur  = this.bal();                     // { balance, held } — PAID tokens only
const outstandingBefore = this.outstandingReservations();
if (!beta && cur.balance < outstandingBefore + amount) {
  return json({ ok:false, error:"insufficient balance", available: ... }, 402);
}
```

And `snap()` two functions above (`do/wallet.ts:172`) makes the distinction explicit:

```ts
spendable: a.free + a.bonus + b.balance
```

`reserve()` uses `b.balance`. It never touches `a.free` or `a.bonus`.

The owner's tokens are **all bonus**. Telemetry confirms it: `wallet_summary_loaded` reports `earned_total = 100`, `spent_total = 5` — that 100 is the one-time welcome grant (`[TOKENS-100-GRANT-1]`, `do/wallet.ts:49-59`, which also retired the old 250/day free grant: `DAILY_FREE_GRANT = 0`). Paid `balance` = **0**.

So: `0 < 0 + 1` → 402 → every AI request fails, forever, for every user who has not paid.

### 2c-bis. Ledger proof — "I have 99 tokens and still get it"

Queried live prod D1 `avatok-wallet` (`63d7181c-0539-4ff2-8690-4ff9bb785457`), `uid = user_3AuqQadIDHJftJtTkLD0DtKM8MB`. **This is his entire wallet history — every row:**

| date | type | app_name | amount |
|---|---|---|---|
| 2026-07-19 15:48 | `promo` | `welcome_bonus` | **+100** |
| 2026-07-20 21:46 | `spend` | `ava_receptionist_call` | −2 |
| 2026-07-23 06:17 | `spend` | `ava_receptionist_call` | −2 |
| 2026-07-23 08:09 | `adjustment` | **`token_hard_reset`** | **+100** |
| 2026-07-24 06:30 | `spend` | `ava_voicemail` | −1 |

**There is no `type='topup'` row. Not one.** Both credits went into the promo bucket, and `hardReset()` (`do/wallet.ts:250-261`) makes it worse than merely "not paid":

```ts
this.setBal(0, 0);                                                    // paid balance -> 0
this.sql.exec("UPDATE acct SET free=0, premium=0, bonus=?1, ...", amount);   // all 100 -> bonus, premium -> 0
```

So on 2026-07-23 the `[TOKENS-100-GRANT-1]` reset **explicitly zeroed his paid balance, put the 100 into `bonus`, and set `premium = 0`.** State today: `balance = 0`, `bonus = 95`, `premium = 0`, `spendable = 95`. The wallet UI shows ~95–99 tokens and it is telling the truth — it displays `spendable`.

### The asymmetry that proves it is a code bug, not a money problem

Same wallet, same tokens, same day — two functions disagree:

| | reads | his 95 bonus tokens | result |
|---|---|---|---|
| `spend()` with `allow_free:true` (`do/wallet.ts`) | `a.free + a.bonus + cur.balance` | **counted** | ✅ his voicemail and receptionist calls debited fine |
| `reserve()` (`do/wallet.ts`) | `cur.balance` only | **ignored** | ❌ 402 on every AI request |

His receptionist calls and voicemail were **billed successfully from those same tokens** on 07-20, 07-23 and 07-24. AI chat, going through `reserve()` instead of `spend()`, sees a balance of zero. The tokens are real, spendable, and already proven spendable by three completed debits. `reserve()` is simply reading the wrong field — it was written for outbound-campaign escrow (`[AVA-CAMP-B1-WALLET]`, where paid-only is correct because escrow can become a payout) and was then reused by `[AI-BILLING-CORE-1]` for AI metering, where paid-only is wrong. **Nobody changed the admission rule when the caller changed.**

Secondary consequence: `hardReset` setting `premium = 0` is also why the `#ava` paywall (pic 4) started firing — it revoked the premium bit on 2026-07-23, two days before the report.

### 2d. Why the user sees "Sorry, I could not find an answer"

`app/lib/core/ava_ai_client.dart:78-100`
```dart
final ok = res.statusCode == 200;
try { j = jsonDecode(res.body); } catch (_) { j = const {}; }
if (!ok && j.isEmpty) {                     // only fires for an EMPTY body
  return AvaAnswer(answer: 'Ava is unavailable right now (${res.statusCode})...', ...);
}
return AvaAnswer(answer: (j['answer'] as String?) ?? '', ...);   // 402 body has no 'answer' -> ''
```

The 402 body is well-formed JSON, so the diagnostic branch is skipped, `answer` becomes `''`, and:

`app/lib/features/askava/askava_screen.dart:165`
```dart
finalText = reply.isEmpty ? 'Sorry, I could not find an answer.' : reply;
```

Neither layer inspects `ans.blocked`, `ans.reason`, or the status code. Neither calls `Analytics.captureException` or `AvaLog`. **A billing rejection was displayed to the owner as a comprehension failure.** That is why AvaBrain looked "not working" rather than "out of tokens", and why it burned a session to find.

### 2e. This is the third time this exact bug class has shipped

- **2026-07-21** — `[RECEPT-AVAIL-SPENDABLE-1]`: receptionist availability gate read paid balance, ignored free coins. Fixed by switching to `spendable` (`worker/src/routes/receptionist.ts:1140-1141`).
- **2026-07-24** — `Specs/AUDIT-MESSENGER-AI-MEDIA-UI-2026-07-24.md:32` documented that `@ava`/`#ava` is paywalled and `betaFreePremium=false` in prod, so free users cannot use it. §H4 proposed removing the premium paywall in favour of wallet metering. **Not implemented.**
- **2026-07-25 (today)** — the same field confusion is live in `WalletDO.reserve()`, now amplified because `aiWalletMeteringEnabled` was turned **on** while the audit's H4 work was still pending.

The receptionist fix patched one call site. It did not establish the invariant.

### 2f. Answers to the owner's direct questions

**"What is the current token rate for AI inside the messenger?"**

Two pricing systems exist. Only one of them is real.

*Legacy flat price list* — `worker/src/feature_pricing.ts:21-44` (1 token = $0.01):

| Operation | Cost | Line |
|---|---|---|
| `ava_chat` — one in-messenger Ava message | **1 token** | :22 |
| `ava_memory` | 1 | :23 |
| `ava_image_free` | 1 | :24 |
| `ava_image_generate` (premium image) | 8 | :25 |
| `ava_voice_reply` | 2 | :26 |
| `ava_vision_snapshot` | 1 | :27 |
| `ava_mcp_tool` | 1 | :28 |
| `guardian_always_on` | 30/month | :29 |
| `ava_receptionist_minute` | 3 | :34 |
| `ava_voicemail` | 1 | :35 |
| `listing_post` | 100 | :42 |

*Live per-token catalog* — `worker/src/lib/ai_billing.ts:78-115`, **active in prod**:

| Model | Input $/1M | Output $/1M |
|---|---|---|
| `moonshotai/kimi-k3` | 3.00 | 15.00 |
| `google/gemini-2.5-flash-lite` | 0.10 | 0.40 |
| `z-ai/glm-5.2` (ChatAVA default) | 0.7546 | 2.372 |
| unlisted model (conservative) | 5.00 | 15.00 |

Formula: provider cost → **×1.30** markup (`AI_MARKUP_BPS = 130`) → **×100 tokens/USD** (`AI_TOKENS_PER_USD = 100`) → ceil, minimum 1 token. A typical chat turn therefore reserves and settles at **1–2 tokens**. Not millions — the "tokens" in the wallet are cents, not LLM tokens; the two meanings are being conflated and that is worth renaming (see §8).

**"Which model is leading it?"**

Three distinct lanes. They are not the same and should never be described as one:

| Surface | Provider | Model | Source |
|---|---|---|---|
| **Ask Ava / AvaBrain / composer** (`/api/ava/gemini`) | OpenRouter | **`z-ai/glm-5.2`** | `routes/ava_gemini.ts:46-53` |
| **`#ava` / `@ava` in-thread agent** (plain text turn) | OpenRouter | **`moonshotai/kimi-k3`**, alt `google/gemini-2.5-flash-lite`, last-resort direct Gemini | `do/ava_agent.ts:74,94,95,582-641` |
| **In-app receptionist** | DeepInfra (`receptionistUseCf=false` → currently the Gemini lane) | Voxtral / Qwen3-32B / Kokoro when CF lane is on | `reception_room_cf.ts` |

The route is *named* `ava_gemini` but has not run Gemini since 2026-06-27. That naming will keep misleading people.

### 2g. Fix

**Immediate (minutes, no build):**
```bash
ALLOW_PROD=1 scripts/flags.sh set aiWalletMeteringEnabled=false
```
This makes `reserveAiJob` a pass-through again and unblocks Ask Ava for every free user tonight. Re-flip only after the code fix lands. *(Owner decision required — do not run without an explicit instruction.)*

**Correct (server, one line, high value):** in `worker/src/do/wallet.ts` `reserve()`, admit on **spendable**, not paid balance. Note `reserve()` is shared with outbound-campaign escrow, where paid-only *is* correct — so gate it on the caller (e.g. an `allow_free` flag mirroring `spend()`) rather than changing it unconditionally:
```ts
const spendable = this.snap().spendable;              // free + bonus + balance
if (!beta && spendable < outstandingBefore + amount) { ... }
```
and mirror it in `consumeReserved()` so the debit draws bonus-first, exactly as `spend()` already does.

**Product (per the audit's §H4):** delete the `_premium` boolean gate on `#ava`/`@ava` (`chat_thread.dart:3242`) and `isPremiumAI()` on AI routes, and let the wallet be the only gate. One meter, one refusal message, one price.

**Client (mandatory, prevents recurrence):** `ava_ai_client.dart` must stop discarding non-200 bodies. Surface `statusCode` + `reason`; `askava_screen.dart` must branch on `blocked`/`reason` and show "You're out of tokens — top up" for `AI_INSUFFICIENT_TOKENS`, and must call `Analytics.captureException`. **A paywall that renders as a comprehension failure is worse than a crash.**

---

## 3. FAMILY B — Layout, navigation and cache (pics 5, 6, 8, 9)

### 3a. Media previews squeezed inside a green band (pics 5, 6)

`app/lib/features/avatok/chat_thread.dart:11002-11007` decides the rendering path:

```dart
final isPureMedia = m.special == null && hasMedia &&
    m.replyTo == null &&
    _mediaCaptionOf(m).isEmpty &&                 // <-- any caption disqualifies
    !isStickerName(...) &&
    (_mediaKind == MediaKind.image || _mediaKind == MediaKind.video);
```

- **`isPureMedia == true`** → edge-to-edge: `width: double.infinity, fit: BoxFit.cover` (`chat_media_cards.dart:679-683`), video sized from `LayoutBuilder` constraints (`chat_thread.dart:11831-11848`). Correct.
- **`isPureMedia == false`** → hardcoded **`width: 220`** — verified at `chat_thread.dart:11699` (local bytes), `:11714` (download placeholder), `:11746` (downloaded image), `:11760` (shimmer), `:11854` (`ChatVideoCard`).

The bubble `Container` is constrained to **78% of screen width** (`chat_thread.dart:11052-11058`) and is stretched wider than 220dp by the caption text, the reply quote box, or the sender-name header. The sender tint fills the difference. That is the green band.

So: **a photo or video sent with a caption, or as a reply, renders at a fixed 220dp inside a much wider bubble.** Both screenshots show exactly that (one is a reply/forward, one has the caption "test video").

Contributing factor: **`ChatMedia` never persists dimensions.** `app/lib/features/avatok/media.dart:27-75` — `toEnvelope()` writes `kind/id/k/nonce/mac/ct/name/size/cap` and nothing else. Every placeholder therefore guesses a box (`220×140`, `220×160`, `width×9/16` at `chat_media_cards.dart:961-965`), so even the loading state is the wrong shape before `BoxFit.cover` takes over.

Non-cause, for the record: the 3px pale hug at `chat_thread.dart:11030-11040` is deliberate (`[AVAGRP-BUBBLE-1]`, owner decision 2026-07-17) and is 3 pixels, not a band.

**Fix:** replace the three `width: 220` literals with the `LayoutBuilder`-derived `cons.maxWidth` already used on the `isPureMedia` path, and add `w`/`h` to the media envelope so `AspectRatio` can be used from the first frame. `MediaKind.file` should also be allowed into `isPureMedia` (line 11007 currently admits only image and video), which is why PDFs never get the edge-to-edge treatment either.

### 3b. Back arrow lands on Inbox (pic 8)

`app/lib/shell/shell_v2.dart` — `_openInbox()` (:535-560) and `_askAva()` (:562-587) both do:

```dart
final nav = _navKeys[_root]?.currentState ?? Navigator.of(context);
nav.push(MaterialPageRoute(...));
```

onto the **same per-root Navigator**, and neither checks whether the other overlay is already open. The footer (`AppSwitcherBar`, the Scaffold's `bottomNavigationBar` at :666-673) stays visible and tappable while Inbox is full-screen — so tapping AvaBrain from inside Inbox produces the stack `[Root, InboxListScreen, AskAvaScreen]`. `AskAvaScreen` has no custom `leading:` (`askava_screen.dart:335-354`), so the default back arrow pops one route and reveals Inbox.

The codebase already knows this hazard: `_dismissOverlays()` (`shell_v2.dart:490-506`, tagged `[AVA-NAV-STUCK-1]`) exists precisely to tear down a stranded overlay — but it is only called from `_switchRoot()`, never from `_openInbox`/`_askAva`.

Commit `7eef7cb` did **not** cause this. Its diff touches only `app_switcher_bar.dart` and `shell_chrome.dart` (label rename + `_avaBrainSlot()`); no Navigator code. But by putting the AvaBrain action on four more surfaces it made the collision far easier to hit — which is why it started being noticed now.

**Fix:** call `_dismissOverlays()` at the top of both `_openInbox()` and `_askAva()`, or hold a single `_overlayRoute` slot that both share.

### 3c. Every inbox row green with an orange dot (pic 8)

The styling is already conditional — `app/lib/features/avadial/inbox/inbox_list_screen.dart:597-666`:
```dart
color: isCampaign ? _campaignCardBg : (hasUnread ? _unreadCardBg : _readCardBg),
... if (hasUnread) <orange dot> else <grey done_all tick>
```

The bug is what feeds `hasUnread` — `inbox_list_screen.dart:557-561`:
```dart
int _unreadCount(InboxThread t) {
  final unheard = t.cards.where((c) => c.hasRecording && !_heardIds.contains(c.stableId)).length;
  if (unheard > 0) return unheard;      // local play-state WINS
  return t.unread ? 1 : 0;              // server read-state only consulted if no recordings
}
```

A card enters `_heardIds` **only when Play is pressed** — by explicit design (`inbox_heard_store.dart:6-9`, and `_markHeardOnce()` at `inbox_thread_screen.dart:719-725` is gated `if (!_c.hasRecording) return;`).

Meanwhile the server-side read flag *is* being cleared correctly: opening a thread calls `InboxApi.markRead(conv)` → `POST /api/msg/read` → `worker/src/do/inbox.ts:854` `UPDATE conv_meta SET unread=0`. It just never gets consulted, because every one of these rows is a voicemail/missed-call thread with a recording.

Result: **"seen" and "heard" are two different states and the badge is keyed to the wrong one.** Every voicemail thread stays green + orange until each recording is individually played. All eight rows in the screenshot are exactly that.

**Fix:** decide the semantic and encode it once. The owner's stated intent ("old = grey, new/unread = green + orange dot") means opened ⇒ read. So `_unreadCount` should return `t.unread ? unheard.clamp(1, …) : 0`, or `_markHeardOnce` should also fire on thread open. Keep an "unplayed" affordance if desired — but as a separate, quieter marker, not the unread badge.

### 3d. Own avatar missing / reloads on every chat open (pic 9)

`AvatarCache` (`app/lib/core/avatar_cache.dart`) is actually good: a real disk cache at `applicationSupport/avatars/<url-tail>_<px>.img` (:41-52), a 500-entry synchronous memory index (`peek()`, :36-39), content-addressed so no TTL is needed, and it renders via `Image.file` — so Flutter's `ImageCache` eviction is not the problem. Three separate defects sit on top of it:

**1 — `_myAvatarUrl` is empty on the first frame of every chat open.** `chat_thread.dart:663` initialises it to `''`; it is only filled asynchronously at `:1131-1134` (`ProfileStore().load().then(...)`). The bubble reads it at `:11293-11298` as `avatarUrl: _myAvatarUrl.isEmpty ? null : _myAvatarUrl` — so it renders initials first, every time. `ChatThreadScreen` is always a fresh `Navigator.push` (no `IndexedStack`, no keep-alive — confirmed across every call site), so `initState` reruns on every open. The peer's avatar does not have this problem because it arrives synchronously on `widget.chat.avatarUrl` and can hit `peek()` on frame one. **This is the "loads slowly every time I come back" complaint, exactly.**

**2 — Cache-key size mismatch.** `Avatar.build()` keys on the display size: `px = (size * 2).round().clamp(64, 512)` (`core/avatar.dart:61`). The post-upload pre-warm writes only `px=192` (`profile_screen.dart:318-328`) — which matches nothing except the profile screen's own `size: 96` avatar. The chat bubble uses `size: 30` → `px = 64`. So after any avatar change or cold start, the bubble takes a full network round-trip that the pre-warm was supposed to prevent.

**3 — One call site can never show a photo at all.** `chat_list.dart:1832` and `:1837` construct `Avatar(seed: ..., name: 'You', size: sz)` with **no `avatarUrl:` argument**, so `core/avatar.dart:58-59` always takes the initials branch.

Per-account scoping is fine — `ProfileStore` uses `readScoped`/`scopedKey` correctly, and the avatar directory is content-addressed so cross-account sharing of a public URL is benign.

**Fix:** cache `_myAvatarUrl` in a synchronous per-account store read at `initState` (or hoist it to a shared `MeStore` singleton so it survives route disposal); pre-warm all in-use `px` values on upload (or drop `px` from the cache key and resize on read); pass `avatarUrl:` at the two `chat_list.dart` sites.

---

## 4. FAMILY C — Receptionist "Save" (pic 10)

**Verdict: a copy-paste regression, live for 26 days.**

`app/lib/features/settings/sections/receptionist_section.dart:420-430`
```dart
Future<String?> _moderateBeforeSave() async {
  final note = _note.text.trim();
  if (note.isEmpty) return null;
  final r = await ModerationService.check(note, ModField.name);   // <-- wrong field type
  ...
}
```

The **availability note** is submitted to `POST /api/moderate` tagged `field_type: 'name'`. `worker/src/routes/moderate.ts:19,49-54` routes any `name` field into `namePlausible()` before any real safety classification:

`worker/src/lib/moderation.ts:46-52`
```ts
const NAME_RE = /^[\p{L}][\p{L}\p{M}'’.\-]*( [\p{L}\p{M}'’.\-]+)*$/u;
if (t.length < 2 || t.length > 60) return false;
if (/\d/.test(t)) return false;                 // no digits in a real name
```

The note box's own placeholder — *"e.g. I'm in meetings until 5pm — please take a message and I'll call back."* (`receptionist_section.dart:687`) — fails on three counts: contains a digit, exceeds 60 characters, and contains an em dash. **Any realistic availability note is rejected.**

How it happened — `git show 0afe01f` (`[PROFILE-GENDER]`, 2026-06-29):
```diff
-  final _name = TextEditingController(); // how Ava refers to the owner
+  final _note = TextEditingController();
...
-    final r = await ModerationService.check(name, ModField.name);
+    final r = await ModerationService.check(note, ModField.name);   // ModField NOT updated
```
The visible Name input was removed (name now comes from Profile — see the comment at `:710`), the controller was renamed, and the `ModField` argument was left behind. `namePlausible` itself is correct and predates this by five days (`67ca76c [AVA-MOD-1]`, 2026-06-24).

Blast radius: `_save` returns `false` before the PUT is ever sent (`:435`), so **the note, expiry, greeting preset, greeting text, festival toggle, and all eight PSTN/AvaTOK scenario toggles are silently discarded.** The CALL LANGUAGE and voice chips are the exception — they persist to local prefs on tap (`google_voice.dart:159-192`), so that selection survives, but the owner has no way to know that.

The partially visible chip he noticed is `Sadaltager` — a Google Chirp **male voice name** (`app/lib/core/voice/google_voice.dart:62`), rendered immediately above the CALL LANGUAGE header. It is not a name input and is not the value being rejected. Reasonable thing to suspect; it's a red herring.

**Fix:** `ModField.name` → `ModField.status` (or `generic`) at `receptionist_section.dart:425`. One word. Separately: `statusNote` is missing from the server-side `guardWrite` list at `worker/src/routes/receptionist.ts:1024-1031`, so the note currently has *no* server-side safety check at all — the client is doing the wrong check and the server is doing none.

---

## 5. FAMILY E — The wallet (pics 1, 2, 3)

**The redesign shipped. It works. Pic 1 is an old screenshot.**

Telemetry from the current build, 2026-07-24 19:31, build 10462:

```
wallet_ledger_loaded    count = 5
wallet_summary_loaded   days=30  spent_total=5  earned_total=100
                        daily_points=30  categories=2  spend_features=2  earn_sources=1
wallet_summary_loaded   days=7   daily_points=7   categories=2      (7D/30D toggle exercised)
wallet_period_changed   x3
```

Both data gates in the screen pass: `if (bars.isNotEmpty)` (`wallet_screen.dart:990`) with 30 points, `if (byCat.isNotEmpty)` (`:1016`) with 2 categories. Money In/Out tiles (`:983-987`) are unconditional. History has 5 rows. Every section the owner says is missing has data behind it on the build he is running.

Corroborating detail: **pic 1's footer shows four tabs ending in "Marketplace".** The current shell (pics 5–10) shows five tabs ending in "Services / AvaBrain". The wallet screenshot therefore predates the shell rebrand. On the older builds the telemetry agrees — `wallet_summary_loaded` on builds 10450/10451/10456 has `daily_points = null, categories = null`, because that client didn't parse those fields yet. That is the version of the screen he photographed.

The redesign landed in six commits on 2026-07-21/22, and the commit messages describe the reported symptom almost verbatim:

| Commit | Date | What it fixed |
|---|---|---|
| `844ea4b` | 07-21 10:48 | *"a throw inside a row builder renders as a BLANK box in a release build"* |
| `f392702` | 07-21 11:39 | dropped a `SliverFillRemaining` branch that left loaded rows unpainted |
| `599b471` | 07-21 16:50 | rewrote `CustomScrollView` → flat `ListView`; *"rendered loaded transactions invisibly on-device"* |
| `3318688` | 07-21 17:01 | Money in / Money out tiles |
| `8910e44` | 07-22 10:15 | full redesign: `daily_spend`, `by_category`, donut, history, CSV export |
| `4479040` | 07-22 10:30 | denormalised charge metadata onto `wallet_transactions` |

Design source: `design/Wallet/AvaWallet.dc.html` (mtime 2026-07-22 09:32), **untracked in git**.

### And yet three real problems are hiding under a false alarm

**1 — The diagnostic built to catch this bug is broken.** `wallet_screen.dart:241-245` emits `wallet_screen_rendered` from a post-frame callback fired in `initState`, before any network response has landed. Its stated purpose is *"lets us verify server-side that the list actually painted N rows."* It has emitted `entries: 0, balance: 0, loading: true` on **every single render for five days**, on every build. It can never do its job. It should re-emit after `_refresh()` completes, with `entries`, `bars`, `cats`, and `summary_ok`.

**2 — `wallet_balance_loaded` carries no balance.** Every one of those 19 events has empty `balance`, `spendable`, `free`, `bonus`, `premium`. Had any of them carried `{balance: 0, bonus: 95}`, the 402 in §2 would have been a two-minute diagnosis instead of a session.

**3 — A latent unguarded query.** `worker/src/routes/wallet_statement.ts:507-522` — the spend/earn/topup/payout block in `walletSummary()` has **no try/catch**, unlike `dailySpend` (:566-587) and `minutesUsed` (:593-599) directly below it, which both degrade gracefully. If it ever throws, `spent_total` is absent, the client's `if (s.containsKey('spent_total'))` guard at `wallet_screen.dart:302` fails, `_summary` stays null, and the chart and donut vanish — reproducing exactly the reported symptom for real. Wrap it.

**On "I spent 1 token and there is no accountability":** the data is all there. `worker/migrations/wallet.sql:17,32` gives every transaction an `app_name` and a `category`; `wallet_statement.ts:28-64` maps ~25 feature keys to human labels; `GET /api/wallet/ledger/:id` + `_showDetail()` (`wallet_screen.dart:1424-1563`) render a full per-transaction sheet with duration × rate. The accountability was never missing — he was looking at a build that predates the screen that shows it. **But he had no way to know that, and neither did we until PostHog was queried.** See §7.

---

## 6. Cross-cutting telemetry gaps

Every one of these made this investigation slower than it needed to be. All violate the bake-in rules already written into `CLAUDE.md`.

| Gap | Location | Consequence |
|---|---|---|
| 402/401/403 rendered as "no answer" | `ava_ai_client.dart:78-100`, `askava_screen.dart:165,202` | Billing failure looks like AI failure. No exception captured. |
| `wallet_screen_rendered` fires pre-load | `wallet_screen.dart:241-245` | The purpose-built render check has never once reported a real render. |
| `wallet_balance_loaded` has no properties | wallet screen | Cannot tell paid from bonus without a DO read. |
| Unguarded D1 block | `wallet_statement.ts:507-522` | Silent section loss, no error surfaced. |
| No `$exception` from either AI failure path | client | 2 `$exception` events in 8 days, neither related. |

---

## 7. Why these keep coming back

Five mechanisms, all fixable.

**1 — Flags were flipped in prod without the code that makes them safe.**
`aiWalletMeteringEnabled = true` is live while `ai_billing.ts:4` still documents itself as *"FLAG-GATED DARK … while off, every exported lifecycle function is a NO-OP PASS-THROUGH."* `betaFreePremium = false` is live while §H4 of the 2026-07-24 audit — the work that removes the premium paywall so metering can safely take over — is unstarted. Two flags flipped in the right direction, in the wrong order, with the code in between missing. This is the single largest contributor.

**2 — A one-site fix was mistaken for a class fix.** `[RECEPT-AVAIL-SPENDABLE-1]` patched `receptionist.ts` on 2026-07-21 to use `spendable`. `WalletDO.reserve()` — the *authority* every other caller goes through — still uses `balance`. Fixing the leaf and not the root guarantees the third occurrence.

**3 — The audit already knew.** `Specs/AUDIT-MESSENGER-AI-MEDIA-UI-2026-07-24.md` names the `#ava` paywall (line 32) and prescribes wallet metering (§H4). It was written the day before these screenshots and has no owner, no issue IDs, and no tracking. **An audit nobody is assigned to is a document, not a fix.**

**4 — Errors are swallowed at the boundary by default.** Three of the ten issues were undiagnosable from the app's own output. `CLAUDE.md` already mandates `Analytics.captureException` on every new async path; the AI client, the wallet balance load, and the receptionist save all predate or ignore it.

**5 — No build-number in bug reports.** The wallet issue cost a full parallel investigation and produced a wrong initial hypothesis, because a screenshot from a pre-redesign build was read as current. Any screenshot-driven report needs the build number attached — it is one line in Settings and it is already in every PostHog event.

---

## 8. Recommended order of work

| P | Item | Where | Effort |
|---|---|---|---|
| **P0** | Decide: turn `aiWalletMeteringEnabled` **off** in prod now, or ship the `reserve()` fix first. Right now every free user's AI is dead. | flag or `do/wallet.ts` | minutes / 1 line |
| **P0** | `WalletDO.reserve()` + `consumeReserved()` → admit and draw on **`spendable`**, not `balance` | `worker/src/do/wallet.ts` | 1 line each |
| **P0** | Surface real errors: `ava_ai_client.dart` stop dropping non-200 bodies; `askava_screen.dart` branch on `reason`; show "out of tokens → top up"; `captureException` | client | small |
| **P1** | Remove the `_premium` AI paywall per audit §H4; wallet becomes the only gate | `chat_thread.dart:3242`, `lib/premium.ts` | medium |
| **P1** | `ModField.name` → `ModField.status` on the receptionist note; add `statusNote` to `guardWrite` | `receptionist_section.dart:425`, `receptionist.ts:1024` | 1 line + 1 line |
| **P1** | Media: replace the three `width: 220` literals with `cons.maxWidth`; admit `MediaKind.file` to `isPureMedia`; persist `w`/`h` in the media envelope | `chat_thread.dart`, `media.dart` | small–medium |
| **P1** | `_openInbox()` / `_askAva()` call `_dismissOverlays()` before pushing | `shell_v2.dart:535,562` | 2 lines |
| **P2** | `_unreadCount()` — make server "read" authoritative; demote "unplayed" to a separate marker | `inbox_list_screen.dart:557` | small |
| **P2** | Avatar: synchronous `_myAvatarUrl` at init; pre-warm all `px` sizes; pass `avatarUrl:` at `chat_list.dart:1832,1837` | client | small |
| **P2** | Fix `wallet_screen_rendered` to fire post-load; add balance/bonus/premium to `wallet_balance_loaded`; wrap `wallet_statement.ts:507-522` | both | small |
| **P3** | Rename the wallet unit. "Tokens" means wallet cents here and LLM tokens everywhere else, and that ambiguity is already causing confusion. Consider **AvaCoins**. | product | — |
| **P3** | Rename `/api/ava/gemini` — it has run OpenRouter GLM since 2026-06-27 | worker | — |
| **P3** | Commit `design/Wallet/` to git; it is currently untracked | repo | — |

### Two process changes worth more than any individual fix

- **Nothing is "flag-dark" until prod KV says so.** Every session that reads a flag value must read it from `/api/config` cache-busted, and every code comment claiming a flag's state should carry the date it was verified. `CLAUDE.md` already says this; it was not followed before the metering flip.
- **A prod flag flip needs the same gate as a prod deploy.** `aiWalletMeteringEnabled=true` had a larger blast radius than most code changes and left no trace anyone could point to. Log every `flags.sh set` against prod with who, when and why.

---

## 9. What is proven vs. what still needs one check

**Proven from live data:**

- 402 on both Ask Ava sends, `premium=false`, build 10462 — PostHog, timestamped
- `betaFreePremium=false`, `aiWalletMeteringEnabled=true`, `aiEnabled=true` — live cache-busted `/api/config`
- `reserve()` admits on paid balance only; `spendable = free + bonus + balance` — source, `do/wallet.ts`
- Wallet has 5 transactions, 30 daily points, 2 categories on the current build — PostHog
- `ModField.name` on the note, and the `0afe01f` diff that caused it — source + git
- All layout/nav/cache root causes — source, line-referenced above

**One check each, still open:**

- **Was the metering flag flip deliberate?** Nothing in the repo or Graphiti records a decision to set `aiWalletMeteringEnabled=true`. Worth confirming before turning it off.
- **Who ran the `token_hard_reset` on 2026-07-23 08:09, and was zeroing `premium` intended?** It is an admin op; it wiped paid balance to 0 and revoked the premium bit, which is what re-armed the `#ava` paywall. If `[TOKENS-100-GRANT-1]` is meant to run for real users, `hardReset` should preserve `premium` for anyone who has ever topped up.
- **PDF/document bubbles.** `ChatFileCard` sizes itself from `cons.maxWidth` and should fill correctly; the fact that files never qualify for `isPureMedia` explains the padding but not a squeeze. Needs one live repro with a PDF to close.
- **Wallet, definitively.** Ask the owner to open AvaWallet on build 10462 and screenshot it. If the chart, donut and 5 history rows appear, §5 is closed as a stale screenshot and only the three latent defects remain.

---

---

# PART II — IMPLEMENTATION SPEC: free text chat + metered multimodal

> **This part is a work order, not a diagnosis. Nothing in it has been implemented.**
> Owner decisions recorded 2026-07-25. Any agent picking this up: read Part I §2 first — the
> `reserve()` bug is a prerequisite, not an optional extra.

## 10. Owner decisions (authoritative)

| Decision | Value |
|---|---|
| **Text chat** | **Free for everyone**, in the messenger (`#ava` / `@ava`) **and** in AvaBrain (Ask Ava). Never metered, never paywalled. |
| **Text model** | **`deepseek/deepseek-v4-flash`** via OpenRouter. |
| **Abuse control** | Free but **rate-limited** — a generous daily cap, kept as a live KV switch so it can be throttled without a build. |
| **Markup** | **Owner intent: 20% on usage-priced AI. SUPERSEDED by Part III §15b–c:** changing `AI_MARKUP_BPS` alone neither produces a real 20% sub-cent price nor changes flat `FEATURE_COSTS`. Implement cumulative micro-USD settlement first and classify fixed retail prices separately. |
| **Paywall scope** | **Text free, attachments metered.** The `_premium` gate comes off text. Sending an image/file to Ava becomes available to everyone, but is charged from the wallet at the multimodal rate. |
| **Rollout** | **Do not implement in this session.** Spec only. |

## 11. Model selection — researched 2026-07-25 from OpenRouter `/api/v1/models`

### 11a. Text chat (free lane) — **`deepseek/deepseek-v4-flash`**

Raw entry, verbatim from the OpenRouter catalog:

```json
"context_length": 1048576,
"architecture": {
  "modality": "text->text",
  "input_modalities": ["text"],
  "output_modalities": ["text"],
  "tokenizer": "DeepSeek"
},
"pricing": {
  "prompt":           "0.0000000938",   //  $0.0938 per 1M input tokens
  "completion":       "0.0000001876",   //  $0.1876 per 1M output tokens
  "input_cache_read": "0.00000001876"   //  $0.01876 per 1M cached-read tokens
},
"top_provider": { "context_length": 1048575, "is_moderated": false }
```

- **Text-only.** `input_modalities: ["text"]` — it **cannot** accept images. Every attachment path must route elsewhere (§11b).
- Supports `tools`, `tool_choice`, `response_format`, `structured_outputs` — so the `@ava` agentic tool-calling loop can run on it.
- 1M context, 284B MoE / 13B active. `is_moderated: false`.
- **Cost reality check:** at $0.0938 in / $0.1876 out, a 2,000-token prompt with a 500-token reply costs **$0.000281** — about **0.028 of one wallet token**. A user would need ~3,500 chat turns to burn a single token. Free text chat is affordable; the daily cap exists to stop scripted abuse, not to control unit cost.

### 11b. Metered lanes — candidates

**Image understanding** (`input_modalities` contains `image`, text out):

| Model | $/1M in | $/1M out | Context | Note |
|---|---|---|---|---|
| `google/gemma-3-12b-it` | **0.0500** | **0.1500** | 131,072 | **Recommended.** Cheapest from a reputable high-volume provider, no per-image surcharge. |
| `google/gemma-3-4b-it` | 0.0500 | 0.1000 | 131,072 | Cheaper output, weaker model. Good fallback / OCR pre-step. |
| `nex-agi/nex-n2-mini` | 0.0250 | 0.1000 | 262,144 | Cheapest overall but Nex AGI is a small, new provider — **do not make it the default**. |
| `mistralai/ministral-3b-2512` | 0.1000 | 0.1000 | 131,072 | Established provider, accepts images. |
| `google/gemini-2.5-flash-lite` | 0.10 | 0.40 | — | Already in our catalog. **Carries `pricing.image = "0.0000001"` → $0.10 per image**, on top of tokens. |

`:free` vision models exist (`gemma-4-*:free`, `nemotron-*:free`) but are subject to OpenRouter's platform-wide free-tier rate limits — unusable as a default for a consumer app.

**Image generation** (`output_modalities` contains `image`):

| Model | $/1M `image_output` tokens | $/1M input text | Note |
|---|---|---|---|
| `openai/gpt-5-image-mini` | **8.00** | 2.50 | **Recommended.** 3.75× cheaper than anything else in the catalog. |
| `google/gemini-3.1-flash-lite-image` | 30.00 | 0.25 | "Nano Banana 2 Lite" |
| `google/gemini-2.5-flash-image` | 30.00 | 0.30 | |
| `google/gemini-3.1-flash-image` | 60.00 | 0.50 | "Nano Banana 2" — what `feature_pricing.ts:25` currently references |

> ⚠️ **Critical for the billing code.** OpenRouter prices image generation through a **separate `pricing.image_output` field**, and it is a **per-token** rate, not per-image. The number of tokens a generated image consumes varies by resolution and provider and is **not** in the models payload. `costMicroUsd()` in `ai_billing.ts` has no `image_output` handling today — it multiplies `images × r.imageUnitMicroUsd`, a flat per-image constant. That model is wrong for OpenRouter and will systematically mis-bill. See §12d.

**Document / page / PDF translation** (text in/out, ≥128k context, output-weighted):

| Model | $/1M in | $/1M out | Context | Accepts image? |
|---|---|---|---|---|
| `mistralai/mistral-nemo` | **0.0190** | **0.0300** | 131,072 | No |
| `inclusionai/ling-2.6-flash` | 0.0100 | 0.0300 | 262,144 | No — cheapest, but obscure provider |
| `meta-llama/llama-3.1-8b-instruct` | 0.0500 | 0.0800 | 131,072 | No |
| `google/gemma-3-4b-it` | 0.0500 | 0.1000 | 131,072 | **Yes** — use for scanned PDFs |

**No model in the entire catalog exposes `file` as a first-class input modality.** A scanned PDF must be rasterised to images and passed to a vision model (`gemma-3-4b-it`), or OCR'd to text first, then translated. Budget for two hops.

### 11c. Recommended assignment

| Job | Model | Metered? | Price |
|---|---|---|---|
| Text chat — messenger `#ava`/`@ava` | `deepseek/deepseek-v4-flash` | **No — free** | $0.0938 / $0.1876 per 1M |
| Text chat — AvaBrain / Ask Ava | `deepseek/deepseek-v4-flash` | **No — free** | same |
| Image understanding | `google/gemma-3-12b-it` | Yes, +20% | $0.0500 / $0.1500 per 1M |
| Image generation | `openai/gpt-5-image-mini` | Yes, +20% | $8.00 per 1M image_output tokens |
| Page / document translation | `mistralai/mistral-nemo` | Yes, +20% | $0.0190 / $0.0300 per 1M |
| Scanned-PDF pre-step (rasterise → text) | `google/gemma-3-4b-it` | Yes, +20% | $0.0500 / $0.1000 per 1M |

## 12. Work order — exactly what to change, and where

**Order matters.** §12a is a prerequisite for everything else; do not skip it and do not reorder.

---

### 12a. PREREQUISITE — fix `reserve()` before anything else

**File:** `worker/src/do/wallet.ts` → `private async reserve(uid, b)`

Today:
```ts
if (!beta && cur.balance < outstandingBefore + amount) { ... 402 ... }
```

`reserve()` is shared with outbound-campaign escrow (`[AVA-CAMP-B1-WALLET]`), where **paid-only is correct** — promo coins must never be able to fund a seller payout. So **do not** change it unconditionally. Mirror the flag `spend()` already uses:

```ts
const allowFree = b.allow_free === true;
const avail = allowFree ? (a.free + a.bonus + cur.balance) : cur.balance;
if (!beta && avail < outstandingBefore + amount) { ... 402 ... }
```

Then make `consumeReserved()` draw in the same order `spend()` does — `free` → `bonus` → `paid` — so a metered AI charge actually consumes the bonus it was admitted against. And in `ai_billing.ts` `reserveAiJob()`, pass `allow_free: true` on the `walletOp` call (AI cost is an internal cost, never a payout).

**Verification:** with a wallet holding only `bonus`, an image-understanding request must succeed and the D1 `wallet_transactions` row must show the debit. Today it 402s.

---

### 12b. Route text chat to DeepSeek, free and unmetered

**Three call sites, all in `worker/src`:**

1. **`routes/ava_gemini.ts:46-53`** — `openRouterModel()` returns `z-ai/glm-5.2`. Change the default to `deepseek/deepseek-v4-flash`. This is the Ask Ava / AvaBrain / composer lane. Keep the `env.OPENROUTER_CHAT_MODEL` override; set it in prod to the same value so the two agree.
2. **`do/ava_agent.ts:94`** — `DEFAULT_THREAD_MODEL = "moonshotai/kimi-k3"`. Change to `deepseek/deepseek-v4-flash`. This is the `#ava`/`@ava` in-thread lane. Leave `DEFAULT_THREAD_MODEL_ALT` (`google/gemini-2.5-flash-lite`) as the fallback — it is cheap and it accepts images, which the primary does not.
3. **`routes/ava_gemini.ts:74`** — `OURKEYS_CHAT_MODEL = "google/gemini-3-flash-preview"`. Reconcile or remove; having three different "default chat model" constants in two files is how the wrong one ends up live.

**Rename while you are in there.** `/api/ava/gemini` has not run Gemini since 2026-06-27 and will now run DeepSeek. Keep the old path as an alias for older clients; add `/api/ava/chat`.

**Make free actually free — do not rely on the flag.** Turning `aiWalletMeteringEnabled` off would also un-meter images, which the owner wants charged. Instead make text chat structurally free, in `worker/src/lib/ai_billing.ts`:

```ts
// alongside the existing isSafetyCapability()
const FREE_CAPABILITIES = new Set(["chat_ava", "chat_thread"]);
export function isFreeCapability(c: string): boolean { return FREE_CAPABILITIES.has(c); }
```
and return the same `{ ok: true, metered: false, reserved_tokens: 0 }` short-circuit that `isSafetyCapability` already produces, at the top of **both** `reserveAiJob()` and `settleAiJob()`. Safety capabilities are already handled this way — follow that pattern exactly rather than inventing a second mechanism.

This makes text chat free **regardless of the global metering flag**, which is the property the owner asked for and the one that survives a future flag flip.

---

### 12c. Remove the text paywall

| File | Line | Change |
|---|---|---|
| `app/lib/features/avatok/chat_thread.dart` | ~3232-3277 | Delete the `if (!_premium)` branch guarding `#ava`/`@ava`. Text always calls `onSummonAva`. Delete the toast at `:3257` and its sibling at `:3249`. |
| `app/lib/features/avatok/chat_thread.dart` | ~677, ~1095 | `_premium` is now only needed to decide *whether to warn before a paid action*, not whether to allow one. Consider replacing it with a `_spendable` int from `MoneyApi.balance()['spendable']`. |
| `worker/src/routes/ava_gemini.ts` | ~275-278 | `if (images.length && !premium) return premiumUpsell(...)` — replace. Attachments are now allowed for everyone and **metered**: run the request on the vision model and reserve against the wallet. Keep an upsell only when `reserve()` genuinely fails for want of tokens. |
| `worker/src/lib/premium.ts` | ~27-39 | `isPremiumAI()` stays (voice, receptionist, other lanes still use it) but must no longer gate text or attachments. Audit every caller before touching it. |

**Do not** delete `isPremiumAI` wholesale — the owner chose *"text free, attachments metered"*, not *"remove premium entirely"*. That larger change is the 2026-07-24 audit's §H4 and is still open.

---

### 12d. Wallet metering for the multimodal lanes

**File:** `worker/src/lib/ai_billing.ts`

1. **SUPERSEDED — do not implement as written.** `AI_MARKUP_BPS = 130 → 120` alone does not produce a real 20% user price. Implement Part III §15b’s cumulative micro-USD settlement, migrate all usage-priced callers to it, and leave fixed retail `FEATURE_COSTS` subject to an explicit product-price decision.
2. **Add the new models to `AI_PRICE_CATALOG`** (~lines 78-115), each with a `verified` date of 2026-07-25:
   - `deepseek/deepseek-v4-flash` — in 0.0938, out 0.1876 (catalogued for completeness even though it is free; a future flip must not fall through to the $5/$15 unknown-model default)
   - `google/gemma-3-12b-it` — in 0.05, out 0.15
   - `google/gemma-3-4b-it` — in 0.05, out 0.10
   - `mistralai/mistral-nemo` — in 0.019, out 0.030
   - `openai/gpt-5-image-mini` — in 2.50, out 2.00, **image_output 8.00 per 1M tokens**
3. **Fix the image cost model.** `costMicroUsd()` currently does `images × r.imageUnitMicroUsd` — a flat per-image constant. OpenRouter bills generated images as **`image_output` tokens**. Add an `imageOutputPerM` rate and an `imageOutputTokens` usage unit, and read the real count from the provider's `usage` object on the response. **Do not hardcode a tokens-per-image constant** — it varies by resolution and provider. If the provider does not report it, fail loudly rather than guessing; a silent wrong guess here becomes a systematic over- or under-charge on every image.
4. **Prefer the provider's reported cost.** `settleTokens()` already accepts `providerCostUsdMicroOverride` and OpenRouter returns `usage.cost`. For image generation especially, **always** use it — the catalog estimate is a fallback, not the source of truth.
5. **`worker/src/feature_pricing.ts`** — `FEATURE_COSTS` still lists `ava_chat: 1` (`:22`) and `ava_image_generate: 8` (`:25`). Once §12b lands, `ava_chat` is dead — remove it or the two pricing systems will keep contradicting each other. Decide whether image generation is flat-priced (`FEATURE_COSTS`) or usage-priced (`ai_billing`) and delete the loser.

---

### 12e. The daily cap

**File:** `worker/src/routes/config.ts`

- `dailyAvaTurnLimit` — currently `25` in DEFAULTS. Raise to a generous number (**200/day/account** suggested) and make it apply to *all* users, not just free ones.
- `openChatUncapped` — currently `false`. With premium gone from text, this flag now means "no cap for anyone". Either wire it to the new free lane deliberately or delete it; leaving a stale flag pointed at a removed concept is exactly how Part I §7 happens again.
- `aiWalletMeteringEnabled` — **leave ON.** After §12b, text is free structurally and this flag only governs the metered multimodal lanes, which is what the owner wants charged.
- **Both keys must be declared in `PlatformConfig` AND `DEFAULTS`, and `dailyAvaTurnLimit` also needs a `numericKeys` entry** (see CLAUDE.md on fake flags — a flag the client reads but `config.ts` does not declare can never be flipped).

The cap enforcement point is `runGated()` in `worker/src/lib/ai_gate.ts` (`skipQuota: premium` at `ava_gemini.ts:~315`). Once premium no longer gates text, `skipQuota` must be re-derived — do not simply pass `true`.

---

### 12f. Telemetry that must ship with this change

Part I §6 lists five gaps that made this investigation slow. Do not add a sixth. With this work:

- Every `reserveAiJob` rejection must emit `ai_job_blocked_insufficient_tokens` with `capability`, `needed`, `balance`, **and** `spendable` — the current event omits the one field that would have identified this bug on day one.
- The client must render `AI_INSUFFICIENT_TOKENS` as **"You're out of tokens — top up"**, never as *"Sorry, I could not find an answer."* (`ava_ai_client.dart:78-100`, `askava_screen.dart:165` — see Part I §2d).
- Every settle must emit the model actually used and the provider-reported cost, so the 20% margin can be verified against reality instead of assumed.

---

## 13. Acceptance criteria

An agent may consider this done when **all** of the following are true:

1. A wallet holding **only** `bonus` tokens can send text in `#ava` **and** in Ask Ava, and gets a real reply. No 402, no toast, no "could not find an answer".
2. A wallet holding **zero** tokens of any kind can still send text and get a reply. Text is free, not cheap.
3. `wallet_transactions` shows **no** row for a text chat turn.
4. Attaching an image produces a reply and an AI usage-ledger row carrying the provider’s actual `usage.cost`. The account’s cumulative marked-up micro-USD debt increases by that amount; a wallet transaction is created only when cumulative debt crosses a whole-token boundary. Across a test batch, `wallet tokens charged × 10,000 + ending debt − starting debt` must equal the batch’s marked-up micro-USD cost to integer rounding tolerance.
5. `ALLOW_PROD=1 scripts/flags.sh set dailyAvaTurnLimit=1` throttles text chat within one minute of a cache-busted `/api/config` reflecting it — proving the cap is a live switch and not a fake flag.
6. Sending 201 text messages in a day hits the cap with a clear message, not a silent failure.
7. `grep -rn "z-ai/glm-5.2\|moonshotai/kimi-k3\|gemini-3-flash-preview" worker/src` returns nothing on the chat lanes.
8. PostHog shows `$ai_generation` events carrying `$ai_model = deepseek/deepseek-v4-flash` for text turns.

## 14. Known traps for whoever implements this

- **`reserve()` is shared.** Campaign escrow must stay paid-only. Use `allow_free`, not a blanket change. (§12a)
- **DeepSeek V4 Flash cannot see images.** Any attachment on the text lane must be re-routed, or it will fail in a confusing way. (§11a)
- **OpenRouter prices generated images per token, not per image.** The existing `imageUnitMicroUsd` model is wrong for this provider. (§12d)
- **Three different default-chat-model constants exist** across `ava_gemini.ts` and `ava_agent.ts`. Changing one and not the others is how the wrong model ends up live. (§12b)
- **`DEFAULTS` is not production.** Three live prod values already differ from it (Part I §1). Verify every flag with a cache-busted `/api/config` read before and after.
- **Commit worker source before deploying it.** The tree is shared by several agents; an uncommitted deploy gets silently reverted by the next agent's deploy (CLAUDE.md).
- **Do not trigger a build.** Builds are manual and owner-initiated only.

---

---

# PART III — INDEPENDENT AUDIT OF PART II, AND IMPROVEMENTS

> Second-pass audit, 2026-07-25, run **against** Part II rather than in support of it.
> **Three findings below invalidate parts of the Part II work order. Read §15 and §16 before writing any code.**

## 15. Three things in Part II are wrong or dangerously incomplete

### 15a. 🔴 Fixing `reserve()` admission alone converts a lockout into unlimited free AI

Part II §12a says to fix admission and "make `consumeReserved()` draw in the same order." The audit shows that is not a follow-up detail — it is the whole fix, and getting it half-right is worse than the current bug.

`worker/src/do/wallet.ts` `consumeReserved()` (~:427-433):
```ts
let balanceAfter = this.bal().balance;
if (!beta && clamp > 0) {
  const cur = this.bal();
  balanceAfter = Math.max(0, cur.balance - clamp);   // ONLY touches paid balance
  this.setBal(balanceAfter, cur.held);
}
```

There is **no `free`/`bonus` deduction path in `consumeReserved()` at all** — unlike `spend()`, which computes `freeUsed` / `bonusUsed` / `paidUsed` explicitly. So if admission is relaxed to `spendable` and this is left alone, a bonus-only user:

1. passes admission,
2. gets the provider call (real cost incurred),
3. reaches `consumeReserved()`, which computes `max(0, 0 − amount) = 0` — **nothing is deducted from anywhere.**

Bonus is never touched, `balance` stays 0, and the platform eats 100% of the cost with zero recovered — **permanently, for every bonus-only account.** Today's bug wrongly blocks paying-eligible users. The half-fix silently gives away unlimited AI. **`reserve()` and `consumeReserved()` must change in the same commit, or neither.**

### 15b. 🔴 A 20% markup is not expressible at the current wallet granularity

This is the most important finding in Part III. 1 wallet token = $0.01. `microUsdToTokens()` does `ceil(cost × 100 / 1e6)` and `reserveAiJob()` does `amount = Math.max(1, est.tokens)`. Every non-zero AI job therefore costs **at least one whole cent.**

Real arithmetic, at the requested 1.20× markup:

| Case | True provider cost | Intended charge @1.20× | Actually charged | **Realised markup** |
|---|---|---|---|---|
| Image understanding — `gemma-3-12b-it`, 1000 in / 300 out | $0.000095 | $0.000114 | **1 token = $0.01** | **≈105×** |
| Page translation — `mistral-nemo`, 3000 in / 3000 out | $0.000147 | $0.000176 | **1 token = $0.01** | **≈68×** |
| Text chat — `deepseek-v4-flash`, 2000 in / 500 out | $0.00028 | $0.000336 | **1 token = $0.01** | **≈36×** |

The markup constant is irrelevant at these sizes — the 1¢ floor dominates completely. **20% only becomes the real margin once provider cost exceeds $0.00833 per request** (i.e. `1 token ÷ 1.20`). That is roughly 30–90× larger than any of the three realistic cases above. Changing `AI_MARKUP_BPS` from 130 to 120 would not move the price of a single one of them by one cent.

Put plainly: **you would be charging users 36–105× your cost while believing you were charging 20%.** That is not a rounding nit. Using the example prices in the table, a 95-token balance represents about **8,333** marked-up image-understanding requests, about **5,397** translated pages, or about **2,827** text turns—not 95. The earlier “~340,000 image lookups” figure was arithmetically unsupported and is withdrawn.

**Recommended design — micro-USD accrual, settle in whole tokens.**

Add a `debt_micro_usd` integer column to the WalletDO `acct` table. On settle:

```
debt_micro_usd += ceil(providerCostMicroUsd × 1.20)
tokens_to_charge = floor(debt_micro_usd / 10_000)      // 10,000 µUSD = 1 token = 1¢
debt_micro_usd  -= tokens_to_charge × 10_000           // carry the remainder forward
if (tokens_to_charge > 0) spend(tokens_to_charge, allow_free: true)
```

This gives a 20% margin to micro-USD precision at any request size, never charges one whole token for a single sub-cent request, never loses the provider cost, and carries a bounded remainder (<1¢). Show the remainder in the wallet detail sheet as “pending usage, under 1 token” so nothing is hidden.

**Reservation still needs a floor**, but “always reserve one token” is not sufficient for long or concurrent jobs. The WalletDO must atomically calculate the headroom needed from `existing debt + worst-case marked-up estimate`, reserve that many whole tokens, then atomically add actual micro-USD debt and consume only the whole-token portion at settlement. A large job may reserve/consume several tokens; a sub-cent job may reserve one token as headroom but consume zero until cumulative debt crosses one cent.

**Cheaper alternative if you don't want the accrual work:** stop metering anything whose realistic cost is sub-cent. Meter only what genuinely costs money — image **generation** ($8/1M image tokens is real money), long documents, voice minutes — and put image understanding and short translations inside the free tier behind a daily cap. Two prices instead of a fake one.

### 15c. 🟠 `AI_MARKUP_BPS` does not reach what you think it reaches

`AI_MARKUP_BPS` (`lib/ai_billing.ts:154`) is referenced **only inside `ai_billing.ts`**. Nothing else imports it. Consequences for the "20% everywhere" decision:

- `worker/src/feature_pricing.ts` has its **own** independent `const AI_MARKUP = 1.30` (`:72`) that `AI_MARKUP_BPS` does not touch. Its three consumers (`reserveAiUsage` / `settleAiUsage` / `meterAiUsage`) have **zero call sites** anywhere in `worker/src` — dead code. The doc comment at `feature_pricing.ts:57` claiming `ava_agent.ts` calls them is **stale**; `ava_agent.ts` calls `reserveAiJob`.
- `FEATURE_COSTS` (`feature_pricing.ts:21-44`) — receptionist minute 3, voicemail 1, image gen 8, listing 100 — are **flat hand-set integers with no markup formula anywhere.** Changing `AI_MARKUP_BPS` reprices none of them.

So "20% everywhere" is, as written, a decision about **one still-dark lane** (ChatAVA text + the util lane + the `@ava` tool loop). Receptionist minutes, voicemail, image generation and listings keep whatever margin their hand-set integers happen to imply — which nobody has computed. **Worth deciding deliberately:** either move `FEATURE_COSTS` onto the same cost-plus formula, or accept that they are fixed retail prices and stop calling it a global margin.

---

## 16. Part I §2 undercounted. The `reserve()` bug has at least six live faces

`reserve()` has **no `allow_free` parameter at all** — it is wrong by construction for every AI use, not merely mis-called. Every caller inherits it:

| Call site | File:line | Bonus-only user gets |
|---|---|---|
| ChatAVA / Ask Ava text | `lib/ai_billing.ts:316` ← `routes/ava_gemini.ts:299,421` | 402 — **confirmed in prod** (Part I §2a) |
| **Util lane — translate, smart replies, catchup, bio, gender infer** | `routes/ai_chat.ts:90` | 402 on all of them. **`translate` is a feature you want to sell.** |
| `@ava` agentic loop | `do/ava_agent.ts:835, 930` | 402 — two reservations per turn |
| AvaBrain Live voice | `lib/voice_billing.ts:334, 416` | 402 at admission (its settle path is correct) |
| Campaign escrow | `routes/wallet.ts:95` | ✅ **correct** — real-money escrow must be paid-only |

And two more paid-vs-spendable reads **outside** the reserve pattern that the 2026-07-21 fix missed:

| Call site | File:line | Effect |
|---|---|---|
| Receptionist **settings-save** gate | `routes/receptionist.ts:1016` — `Number(bal.body?.balance ?? 0) < needTokens` | Bonus-only owner is told "insufficient tokens" trying to **turn on** the receptionist — in the same file, a few hundred lines above the gate that *was* fixed at `:1300` |
| **PSTN / DID** inbound-call agent gate | `routes/pstn.ts:259` | Bonus-only owner's PSTN receptionist silently degrades to no-answer/voicemail |

`RECEPT-AVAIL-SPENDABLE-1` fixed **one of at least four** call sites in the receptionist lane alone. Part I §7's "a one-site fix was mistaken for a class fix" was, if anything, generous.

**Improvement — make the class un-repeatable.** A one-line fix at six sites will regress a seventh time. Instead:

1. Rename `bal()` → `paidBalanceOnly()` inside the DO so every future reader has to acknowledge what it is.
2. Give `reserve()` a **required** `allow_free: boolean` parameter — no default. Every existing call site then fails to compile until someone states the intent. That is the only mechanism that actually stops recurrence #4.
3. Add a vitest that asserts: a wallet with `{balance: 0, bonus: 100}` can reserve, consume, and be debited to `bonus: 99` for an `allow_free` op, and **cannot** reserve for a payout op. `worker/verify.yml` already runs vitest — this is the compile net the CLAUDE.md orchestrator pattern relies on.

---

## 17. There is a SECOND, independent cause of the pic-4 paywall

Part I blamed the `#ava` toast on `premium = 0`. True — but not the only way to get there.

`app/lib/core/money_api.dart` — every **GET** helper drops the HTTP status entirely:
```dart
static Map<String, dynamic> _json(String body) {
  try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
}
static Future<Map<String, dynamic>> balance() async =>
    _json((await ApiAuth.getSigned('$kWalletBase/balance')).body);
```
No `statusCode` check. A 401, a 500, a gateway timeout, or any non-JSON error page silently becomes `{}`. Then:

- `chat_thread.dart:1095` — `b['premium'] == 1 || b['premium'] == true` → **false** → the paywall toast fires **for a premium user on a flaky network.**
- `paid_call_prompt.dart:100`, `live_viewer_screen.dart:171` — `?? 0` → user is told they have **0 tokens** and a call they can afford is blocked.
- `ava_sidebar.dart:130`, `library_ingest.dart:34` — paid features silently disappear.

So a wallet fetch failure is indistinguishable from being broke and unentitled, on five surfaces, with **no telemetry**. `MoneyApi._post` (the mutating path) already does this correctly — it attaches `'status': res.statusCode` and distinguishes an empty-body 4xx from a network error. **`_json` should simply be brought up to `_post`'s standard.** Small change, removes an entire class of phantom bug report.

Credit where due: `core/api_auth.dart`'s `_tracked()` wrapper is genuinely well built — it fires `Analytics.apiError` on every ≥400 and every transport throw, plus 401 auth-repair and 403 consent handling. The status code *does* reach PostHog (that is how Part I §2a was provable). The defect is one layer up, in business-logic wrappers that coerce a missing field to a plausible-but-wrong default.

Worst offender found, worse than the one Part I already documented — `askava_screen.dart:202-204`:
```dart
} catch (_) {
  finalText = 'Ava could not be reached. Please try again.';
}
```
This wraps the entire multi-hop tool loop. The exception is bound to `_` and discarded. No `captureException`, no `AvaLog`, no status. **Any** failure in that block renders one string with zero trace.

---

## 18. Fake flags found — and one of them blocks the feature you just asked for

Full diff of 81 client-read keys against 198 declared keys:

**FAKE (client reads, `DEFAULTS` does not declare → un-flippable, fallback is permanent):**

| Key | Read at | Permanent value | Why it matters |
|---|---|---|---|
| `imageGenEnabled` | `remote_config.dart:289` | **`true`** | 🔴 **Directly blocks Part II.** The client's local "coming soon" short-circuit (`image_tool.dart:68`) can never fire. The real server gate is a **differently-named key**, `generativeEnabled` (`config.ts:158`, DEFAULT `false`, enforced `routes/ava_image.ts:301,368`). Net effect today: every image-gen tap makes a real POST and eats a 503 `generative_disabled`. Fix the name mismatch before wiring `gpt-5-image-mini`, or you will ship a paid feature behind a flag that cannot be opened. |
| `aiVoiceCallEnabled` | `remote_config.dart:265` | **`false`** | Hands-free Ava voice can never be enabled. The docstring at `:263` instructs flipping it in KV — that write 400s `unknown key`. |

**NUMERIC-BROKEN (numeric in `DEFAULTS`, missing from `numericKeys` → `flags.sh set` returns 400 `bad type`):**

- **`imageDailyCap`** (default 100) — 🔴 the per-user/day image abuse cap. **You cannot tune it.** This is the exact lever you need once image generation is metered.
- `livenessValidityDays` (default 90)

**ORPHAN (declared, read by nothing — dead config surface):** `callProtocolVersion`, `companionEnabled`, `imageDailyCap`, `ivrAiFrontDesk`, `networkReconnectWindowSec`, `offlineDetectSec`, `escrowPromptTimeoutSec`, and 8 `campaign*` sub-knobs. Note **`companionEnabled`** — documented as gating "New chat with Ava + personas," read by nothing, so that feature is ungated or gated elsewhere.

No worker-side fake flags: the `PlatformConfig` interface and `DEFAULTS` are in exact 1:1 sync (198/198), so `readConfig(env).X` typechecks by construction.

Adding `imageDailyCap` to `numericKeys` is necessary but **not sufficient**: `routes/ava_image.ts` currently enforces `PLANS[tier].caps.image` and never reads `cfg.imageDailyCap`. As written, `imageDailyCap` is both unwritable and unused. The implementation must either wire it as a global per-account backstop in `runAvaImage()`/`generateAvaImageSync()` or remove it and designate the plan cap as canonical.

**Improvement:** this diff should be a CI check, not a periodic audit. A ~30-line script in `verify.yml` that extracts client keys and worker keys and fails on any asymmetry would have caught `inAppUpdateEnabled` (2026-07-15), both of these, and both numeric-broken keys — automatically, forever. A second check must verify that declared kill switches/caps have at least one production source reader; name symmetry alone cannot detect an orphan such as `imageDailyCap`.

---

## 19. The cost and abuse model for free chat is more complicated than it looks

### 19a. A "free turn" is three model calls, not one

`runGated()` (`worker/src/lib/ai_gate.ts:210-255`) runs, in order:

1. `guardInput()` — mandatory input moderation on **every** tier including BYO
2. `args.generate()` — the actual reply
3. `isSafe(answer)` — output guard, **plus a full regenerate** if it trips

So per free turn you pay for at least two safety calls plus generation, and up to **two** generations. Safety capabilities are correctly exempt from metering (`isSafetyCapability`) — meaning they are free to the user and billed entirely to you. Budget free chat at roughly **3× the naive per-turn cost.** Still cheap (~$0.0008/turn), but the sizing should be honest.

Reassuring corollary: because `guardInput`/`isSafe` are ours and mandatory, DeepSeek V4 Flash's `"is_moderated": false` is **not** a safety hole. Our rails are model-independent. Worth stating explicitly since an unmoderated model on a free unlimited tier would otherwise be a Play-policy concern.

### 19b. A turn cap does not cap cost — 1M context does

`dailyAvaTurnLimit` counts **turns**. DeepSeek V4 Flash has a **1,048,576-token** context window. One user pasting a large document into free chat 200 times a day could push ~200M input tokens — about **$19/day from one account**, entirely within the cap. The cap is the wrong unit.

Add, alongside the turn cap:
- a **per-turn input cap** (e.g. 32k tokens) — reject or truncate above it with a clear message;
- a **per-account daily token budget** (e.g. 2M tokens/day), which is the metric that actually bounds your bill;
- an **org-wide daily spend circuit breaker** that trips and degrades to a cheaper model or a queue rather than silently running up an OpenRouter invoice. Nothing in the codebase currently bounds total AI spend.

### 19c. Prompt caching is 5× cheaper and you are not using it

DeepSeek V4 Flash: `input_cache_read = $0.01876/1M` vs `prompt = $0.0938/1M`. The system prompt plus conversation history is re-sent on every turn and is exactly what caching is for. Wiring OpenRouter's cache-control on the stable prefix should cut free-chat input cost by roughly 80%. Cheap win; do it while touching the call sites anyway.

### 19d. A client retry double-charges and double-runs the model

Every AI path mints `opId = crypto.randomUUID()` **server-side, per HTTP request** (`ava_gemini.ts:295,417`, `ai_chat.ts:89`, `ava_agent.ts:832,927`). WalletDO's dedupe only catches a replay of the *same* `op_id`. A client timeout + resubmit of an identical message therefore mints a fresh opId, reserves again, calls the provider again, and settles again — **full double charge, double generation.** The code comments acknowledge it ("chat is not naturally idempotent") but nothing mitigates it. Fix: have the client send an idempotency key derived from `(threadId, messageId)` and dedupe server-side for ~60s. Matters much more once attachments are metered, because those are the expensive ones.

### 19e. Orphaned reservations can lock a user out of their own tokens for 6 hours

`AIJOB_RESV_TTL_MS = 6h`. `reapStaleAiJobReservations()` runs lazily at the top of the *next* `reserve()` for that uid, and on the DO `alarm()` — but **`reserve()` never schedules an alarm** (only pending holds/audit-outbox do). So if a Worker dies between reserve and settle and the user has no other wallet activity, the orphaned reservation keeps counting against `outstandingReservations()` and shrinks their admission headroom for **up to 6 hours**. A user with tokens gets 402s for nothing that was ever charged. Shorten the TTL to minutes for chat-scale jobs, and have `reserve()` schedule the reaper alarm.

### 19f. An unlisted model bills at 100× its real rate

`rateFor()` falls back to `AI_DEFAULT_RATE` = **$5 in / $15 out per 1M** for any model not in `AI_PRICE_CATALOG`. `gemma-3-12b-it` is $0.05/$0.15 — so routing it before cataloguing it would bill at **100× cost**. Part II §12d listed cataloguing as a step; it is not housekeeping, it is a correctness prerequisite. Better still: **fetch prices from OpenRouter's `/api/v1/models` at runtime** (cache 24h in KV) and treat the in-code catalog as the fallback. Hand-maintained price tables go stale silently and this one already has a `google/gemini-3.5-flash` placeholder marked `TODO`/unverified sitting in it.

---

## 20. Improvements worth adding that you didn't ask for

**1. Shadow-meter the free tier.** Write a **zero-charge** ledger row for every free text turn recording model, tokens and true provider cost. You get per-user cost visibility and the data to decide whether free is sustainable, without charging anyone. This also directly answers your "I spent 1 token and there is no accountability" complaint — the free tier would become the best-instrumented part of the wallet rather than invisible.

**2. Rename the wallet unit.** "Tokens" means cents in your wallet and model tokens in every AI context. That collision produced your "millions of tokens" question and will produce a support ticket every week. **AvaCoins**, 1 coin = 1¢, and never say "token" in the UI again.

**3. One refusal vocabulary.** Right now: `_capNote` toast, `premiumUpsell`, `REFUSAL`, the quota string, `"Sorry, I could not find an answer."`, `"Ava could not be reached."`, `"Ava is temporarily unavailable."`. Seven ways to say no, and the user cannot tell "out of tokens" from "AI is down" from "you said something blocked". Collapse to three — **out of coins / rate-limited / temporarily unavailable** — each with a distinct action, and make every path map onto one of them.

**4. Fix the quota copy before it ships.** `ai_gate.ts:238`: *"You've reached today's free Ava limit. Connect your own Gemini key (Settings → Ava AI) for unlimited use."* Post-change this is wrong twice — it is not Gemini, and BYO-key is no longer the escape hatch for a free tier that is already free.

**5. Publish the price list in-app.** A "what things cost" screen reading the live catalog. It is the cheapest possible answer to "there is no accountability," and it forces the two pricing systems (§15c) to be reconciled, because you cannot display two contradictory prices for the same operation.

**6. Consider a `:free` model for the free lane.** Several `:free` OpenRouter models cost literally $0 (`openai/gpt-oss-20b:free`, `gemma-4-*:free`). They carry platform-wide rate limits, so they are not a default — but as the **first** attempt with DeepSeek V4 Flash as the paid fallback on 429, your free-tier bill approaches zero. Worth a spike before committing to paid-for-free.

---

## 21. Revised work order

Supersedes Part II §12 where they conflict.

| Order | Item | Why this position |
|---|---|---|
| **1** | `reserve()` + `consumeReserved()` in the **same commit**, with a **required** `allow_free` param and a vitest for the bonus-only case | §15a — half of this is a revenue hole, not a fix |
| **2** | Decide the sub-cent question: **micro-USD accrual** or **don't meter sub-cent ops** | §15b — every later pricing decision depends on it |
| **3** | Patch the four other paid-only reads: `ai_chat.ts:90`, `ava_agent.ts:835,930`, `voice_billing.ts:334,416`, `receptionist.ts:1016`, `pstn.ts:259` | §16 — translate, PSTN and voice are broken for bonus-only users right now |
| **4** | Add a status-preserving `MoneyApi` GET wrapper **and update all entitlement callers to represent `unknown/error` separately from `premium:false`** | §17 — status preservation alone still produces a false paywall if callers coerce errors to false |
| **5** | Fix the `imageGenEnabled` / `generativeEnabled` name mismatch; add `imageDailyCap` to `numericKeys`; wire the cap into both image-generation entry points | §18 — a writable but unread cap is still fake |
| **6** | Route text chat to DeepSeek + `FREE_CAPABILITIES` short-circuit (Part II §12b) | unchanged |
| **7** | Input-token cap + daily token budget + org spend circuit breaker | §19b — the turn cap does not bound your bill |
| **8** | Runtime price fetch from OpenRouter, in-code catalog as fallback | §19f — beats hand-maintaining a table that is already stale |
| **9** | Remove the text paywall (Part II §12c) | unchanged, but after 1-5 |
| **10** | Idempotency key; shorten reservation TTL + schedule the reaper | §19d, §19e |
| **11** | Prompt caching on the stable prefix | §19c — ~80% off free-chat input cost |
| **12** | Client-key ↔ server-key asymmetry check in `verify.yml` | §18 — makes fake flags impossible rather than periodically audited |
| **13** | Shadow-meter the free tier; unify refusal copy; rename token → coin | §20 |

**What I would not do:** change `AI_MARKUP_BPS` to 120 as a standalone action. Per §15c it reprices nothing live, and per §15b the floor makes the constant irrelevant at real request sizes. Do §15b first; the markup constant only starts to mean something afterwards.

---

*Part I compiled 2026-07-25 — all flag values read live from production, none taken from `DEFAULTS`; line numbers against `main` @ `7eef7cb`. Part II records owner decisions of 2026-07-25 and OpenRouter catalog pricing retrieved the same day; prices must be re-verified before implementation. Part III is an independent second-pass audit of Part II, same date, and supersedes it where they conflict.*

# PART IV — STABILITY-FIRST AVABRAIN PRODUCT PLAN

## 22. The important correction: the session UI exists, but the main Ava surface does not use it

The requested AvaBrain experience is **partly implemented in the repository**. It is not safe to describe it as “missing” or to build a second session system.

`app/lib/features/ava_companion/companion_home.dart` already provides:

- a local-first list of previous Ava sessions;
- a `New chat` button and persona picker;
- open/resume from a session card;
- a separate Archived chats section;
- per-card star, rename, archive/unarchive, delete and reorder actions;
- cloud backup and cross-device metadata sync through `ava_chat_history.ts`;
- an explicit AvaBrain Memory entry and “Discuss a chat” entry.

The user-visible split is the root problem:

| Entry point | Current destination | Result |
|---|---|---|
| Main shell Ava action | `AskAvaScreen` from `shell_v2.dart::_askAva()` | Quick assistant overlay; no session home/cards |
| Sidebar / older messenger entry | `CompanionHome` | Session list and New chat UI |
| Discuss-a-chat action | `CompanionThreadScreen` directly | Contextual one-off chat, bypasses session home |
| `#ava` / `@ava` | Messenger thread route | Separate agent lane and identity |

Therefore the product feels as if AvaBrain has no history even though the code has a history product. The permanent fix is to make **CompanionHome the canonical AvaBrain destination** and retain Ask Ava only as a deliberately named quick action inside the shell or inside a session—not as a competing “AvaBrain” identity.

## 23. AvaBrain is not yet “the brain of the user’s past, present and future”

The current implementation proves useful foundations, but not the full promise:

1. **Past:** Companion turns are saved locally and mirrored to D1, and the local recall lane can index substantive user messages. Server Brain recall is consent-gated and domain-filtered. This is real, but the personal chat, Ask Ava and Messenger agent still do not share one canonical session identity or one response contract.
2. **Present:** Companion builds a prompt from persona, profile context and up to four recall hits. This is bounded and safer than dumping history, but it is not yet a single server-side Brain gateway with consistent citations, model/provider telemetry, wallet operation IDs and fallback behavior across all surfaces.
3. **Future:** The repository has domain registry/ingestion foundations, but goals, reminders, calendar, wallet activity, calls, files/media and proactive actions are not all guaranteed to flow through one verified ingestion contract. “Ava knows everything” must mean “Ava can recall consented, indexed, source-linked domains,” not “every screen silently sends all data to a model.”

The prior product bible is directionally correct: event history, searchable memory and per-turn context are different guarantees. The implementation plan must preserve that separation while giving the user one coherent product.

## 24. Stability diagnosis for the AvaBrain/session problem

This is a new root-cause family, **G — canonical-surface and state-authority split**, with four recurring mechanisms:

### G1. Two products share the name “Ava”

`_askAva()` pushes `AskAvaScreen`, while the session-list product lives under `CompanionHome`. A fix to one surface does not fix the other. This is the same structural failure as the wallet `spend()`/`reserve()` split: two authorities answer the same user question differently.

### G2. Overlay navigation is not mutually exclusive

`_openInbox()` and `_askAva()` push routes on the same per-root Navigator and track them, but neither dismisses the existing overlay before opening the other. A stack such as `Root → Inbox → Ask Ava` explains the back arrow exposing Inbox; the reverse stack explains the top arrow returning to Inbox unexpectedly. Tracking a route is not the same as enforcing one active overlay.

### G3. Session persistence is best-effort at the wrong durability boundary

`CompanionThreadScreen` persists on close and after successful turns, which is good for normal use, but a crash, force-close or process kill between turns can lose the latest transcript. Cloud metadata writes are fire-and-forget with no durable retry queue. A cloud failure can leave two devices with different archive/delete/rename state.

### G4. Memory recall is real but not observable enough to prove “Brain worked”

The companion calls `brainRecall()` only when local mode is active and records a small client event, while the server `UserBrainDO` has a separate recall/reasoning path. There is no single per-turn trace showing: domains searched, consent decisions, hit count, citations, model actually used, provider fallback, wallet result, and whether the answer was grounded or model-only. A user can therefore experience “Ava forgot me” without a truthful explanation of whether memory was empty, disabled, private-by-design, degraded, or simply not queried.

## 25. Canonical UI contract to build

The AvaBrain landing page must be a stable home, not a transient chat overlay:

```text
AvaBrain Home
├── Header: back → previous app/root; no hidden route jump
├── New chat → creates a new session immediately, then opens the thread
├── Active sessions
│   └── card: title, last-message preview, updated time, persona, status
│       └── menu: Open, Rename, Archive, Delete (and Star if retained)
├── Archived chats
│   └── same cards; menu includes Open, Unarchive, Delete
├── Memory
│   └── review, correct, forget, export, consent by domain
└── Discuss a chat
    └── explicit local-only transcript grounding and return-to-chat behavior
```

User-visible rules:

- “Open” is the primary card action; the three-dot menu must still contain Open for accessibility and discoverability.
- Archive removes a card from Active immediately and makes it visible in Archived chats; it must not delete the transcript.
- Delete requires confirmation, removes the local row immediately, creates a tombstone, and shows a pending-sync state if cloud deletion has not completed.
- New Chat must not require a title. Auto-name from the first user message, with Rename always available.
- Loading, empty, offline, sync-failed and memory-disabled states must be distinct. Never show a blank screen as a generic failure.
- Back from a thread returns to AvaBrain Home. Back from AvaBrain Home returns to the previous app/root. It must never reveal Inbox unless Inbox was the actual previous route.

## 26. Permanent implementation plan (do in this order)

### P0 — make the product entry point truthful

1. Change the main shell AvaBrain action to open `CompanionHome`, not `AskAvaScreen`.
2. Give Ask Ava a separate label and route purpose (for example, “Quick Ask”) or make it a mode within the canonical home. Keep the compatibility route for older clients.
3. Define one `AvaSurface`/session contract containing `session_id`, `surface`, `context_hint`, privacy mode, recall packet, model/provider usage, operation ID and user-visible error code. All personal text surfaces adapt to it.

### P0 — enforce one-overlay navigation

1. Replace the two independent route variables with one overlay controller/slot, or call `_dismissOverlays()` before every `_openInbox()` and AvaBrain/Quick Ask open.
2. Add route-result telemetry with `from_route`, `to_route`, `overlay_before`, `overlay_after` and `back_result`.
3. Acceptance test the four transitions: Root→AvaBrain→Back, Root→Inbox→Back, Root→Inbox→AvaBrain→Back, Root→AvaBrain→Inbox→Back. At most one overlay may exist.

### P1 — make session durability reliable

1. Generate session IDs with UUIDs, not millisecond timestamps.
2. Checkpoint the transcript after each completed turn and with a short debounce while streaming; close-time persistence remains a final flush, not the primary save.
3. Add a per-account outbox for cloud saves and metadata mutations. Retry with idempotency keys and expose “synced / syncing / offline” non-blocking status.
4. Define conflict rules: transcript uses newest valid revision; metadata mutations use operation timestamp/version; delete tombstones win over stale cloud rows.
5. Put server-side limits and pagination around transcript size; never silently truncate a user’s only copy without a visible export/retention rule.

### P1 — make memory verifiable and honest

1. Route Companion, Ask Ava and `#ava` through one server-side personal-brain gateway where privacy/consent is checked once and the response includes a bounded recall packet.
2. Keep private Messenger content device-local by default. If the user explicitly allows cloud grounding, send only bounded excerpts and record the consent snapshot.
3. Return citations/source domains and a truthful `grounding_status`: `grounded`, `no_matching_memory`, `consent_off`, `private_local_only`, `degraded`, or `model_only`.
4. Add memory controls to the landing experience: what Ava can remember, domain toggles, review/correct/forget/export, and a visible “why Ava knows this” affordance.
5. Complete domain producers in a matrix: profile, chats, files, media, calls/voicemail, wallet, calendar, goals/reminders, listings and future activity. Each row must have source ID, consent key, retention, deletion path, recall test and telemetry.

### P1 — join billing and observability to the same turn

The Part II free-text/metered-attachment plan remains valid, but it must be implemented through the canonical session contract. Every turn must show one trace from UI → recall → provider → reserve/settle (or free lane) → persisted session. A 402, provider failure, empty recall and moderation block must each produce a distinct user message and PostHog event.

### P2 — UI polish after authority is fixed

Only after the above is stable should the visual pass be applied: use the approved wallet/AvaBrain design assets, add card hierarchy and consistent empty states, and verify the design on the current build number. A screenshot or design file is not “shipped” until the corresponding screen is reachable from the canonical route and a telemetry event proves it rendered after data load.

## 27. Definition of done for a permanent fix

The AvaBrain work is not complete when the screen looks good. It is complete when:

1. The main AvaBrain action always opens the session home with old sessions, New Chat and Archived chats.
2. A user can open, rename, archive, unarchive, delete and create sessions offline; state converges after reconnect without resurrection of deleted chats.
3. Every back transition returns to the actual previous surface; Inbox and AvaBrain cannot coexist as stacked overlays.
4. Force-closing after a completed turn does not lose it; cross-device history and metadata converge.
5. A memory-grounded answer reports its source domains and grounding status; a non-grounded answer does not imply that Ava remembered the user.
6. Text chat is free and attachment work is metered exactly as Part II specifies; no text turn creates a wallet debit.
7. PostHog can retrieve one complete trace by account, build, environment and operation ID without storing private message bodies.
8. CI tests cover wallet bucket semantics, session CRUD/sync/tombstones, overlay exclusivity, unread/read semantics, media aspect ratios, avatar cache hits, receptionist save validation, and all user-facing error mappings.

## 28. Ownership and rollout gates

Assign one issue ID per authority, not one screenshot:

- `[AVA-CANONICAL-SURFACE-1]` — shell entry and session contract;
- `[AVA-NAV-EXCLUSIVE-1]` — one overlay slot and back behavior;
- `[AVA-SESSION-DURABILITY-1]` — checkpoint/outbox/conflict rules;
- `[AVA-BRAIN-RECALL-TRUTH-1]` — consent, citations and grounding status;
- `[AVA-BRAIN-DOMAIN-MATRIX-1]` — source/retention/deletion coverage;
- `[AVA-UX-REGRESSION-1]` — screenshot/build/telemetry evidence gate.

Each issue gets: owner, exact files, staging acceptance evidence, PostHog event names, rollback plan and production approval. No flag may be flipped until its guarded code path, telemetry and rollback are present. This is the process change that prevents another audit from becoming a historical report instead of a permanent fix.

### Pricing note

OpenRouter currently displays DeepSeek V4 Flash at approximately **$0.09 input / $0.18 output per 1M tokens** on the model page, with provider-effective prices varying by routing/provider. The implementation must read the provider’s actual usage/cost fields and re-check pricing immediately before rollout; the OpenRouter model page is the source of truth, not a stale constant in the repository: [DeepSeek V4 Flash pricing](https://openrouter.ai/deepseek/deepseek-v4-flash/pricing).

# PART V — AI LATENCY AND FAST-RESPONSE PLAN

## 29. Evidence and investigation limits

The existing AvaBrain audit contains account-linked production telemetry for `hdavy2002@gmail.com` and reports:

- average reply latency: **5.9 seconds**;
- p50: **5.3 seconds**;
- p90: **10.7 seconds**;
- the intended verification target: p50 under 3 seconds after the model switch.

This session did not have a PostHog connector exposed, so I could not run a fresh account query. I am not presenting a new PostHog measurement as if I retrieved it today. The conclusions below are based on the stored telemetry findings plus the current source paths. Before rollout, PostHog must be queried again for this account using the events and properties in §33.

## 30. Root cause: “thinking” is a combination of UI wording, model behavior and serial gates

The visible “Ava is thinking…” state is generic UI copy. It does not prove that chain-of-thought is being shown. The delay comes from several concrete sources:

### 23a. Ask Ava waits for the whole answer

`app/lib/features/askava/askava_screen.dart::_send()` calls `AvaAiClient.ask()`, not `askStream()`. The user sees no answer until the entire HTTP request completes. Ask Ava can also perform up to `_maxHops` sequential model calls when the model emits a tool request: model → local tool → model again. That is correct for tool use but unacceptable as the default experience for ordinary questions.

### 23b. Companion streaming starts too late

`CompanionThreadScreen` does use `askStream()`, but the server stream route performs work before it opens the provider stream:

1. authenticate;
2. resolve premium state;
3. run `brainSearchLines()` against AI Search and possibly Vectorize;
4. build the system prompt plus history and memory lines;
5. reserve the AI job;
6. call OpenRouter;
7. only then emit the first SSE delta.

This means streaming improves rendering after the first token, but does not solve time-to-first-token. The UI remains on “thinking” during every serial preflight step.

### 23c. The intended fast model switch is not live in source

`worker/src/routes/ava_gemini.ts::openRouterModel()` still defaults to **`z-ai/glm-5.2`**. The earlier implementation specification proposes `deepseek/deepseek-v4-flash`, but that is not yet implemented. The model choice, environment override and stream route must be verified together; changing only one constant will reproduce the split-brain model problem.

The shared gateway’s streaming path pins the requested model and does not add a fallback. A slow or unavailable pinned model therefore delays or fails the stream instead of quickly switching to a known fast fallback.

### 23d. Messenger `#ava` is a different, potentially multi-round product

The Messenger agent lane uses `runAgentLoop()` and can execute up to six tool/model steps. A single request involving Gmail, Calendar, Drive, image generation or another connector legitimately takes longer, but a normal conversational question must not enter that loop. The primary agent model remains `moonshotai/kimi-k3` unless an environment override changes it; its fallback can add another full model call after timeout/429/5xx/parse failure.

The 45-second per-step timeout is an outage guard, not a user-experience target. A normal chat request should have a fast lane with a short deadline and a clear handoff to “this needs tools” only when the request actually requires tools.

### 23e. “Thinking off” is inconsistent across lanes

Gemini direct adapters have explicit per-model thinking-off configuration. The OpenRouter chat body used by `avaReason` is built with `allowAiOptions: false`, and the pinned OpenRouter chat path does not pass a provider-specific low-reasoning setting. The prompt says “no analysis,” but prompt text is not a reliable latency control. The chosen fast model must be configured through the provider-supported reasoning setting, or explicitly selected from a non-reasoning/low-latency variant.

### 23f. Telemetry cannot currently distinguish “slow before stream” from “slow model”

The server emits total/setup/gen timings for the non-streaming route, and `ava_reason_call` records model latency for buffered calls. The streaming path currently emits a gateway event with `latency_ms: 0`, and the client does not record `request_started`, `first_delta`, `stream_completed`, `fallback`, or `tool_round` timestamps. This prevents PostHog from answering the key question: did the user wait on Brain Search, reservation, provider queueing, model thinking, network buffering, or tool execution?

## 31. Fast-response design: two explicit lanes

Do not optimize every request with one universal timeout. Split requests by capability:

| Lane | Examples | Behavior | Target |
|---|---|---|---:|
| **Fast chat** | ordinary text questions, companion chat, simple `#ava` reply | one model call, no tools, streaming, low reasoning, bounded context | first delta ≤1.5s p50, ≤3s p95 |
| **Work/agent** | search contacts, Gmail/Calendar/Drive, translation, image/file work | explicit progress states, tool/model steps, metered if applicable | first progress ≤1s; completion reported separately |

The fast lane must never silently become the work lane because the model guessed that a tool might be useful. Tool intent should be classified deterministically before the expensive agent loop, or the user should explicitly select “Use my apps / search my data.”

## 32. Concrete fix order

### P0 — make every ordinary chat visibly stream

1. Add a streaming Ask Ava client path using the existing `/api/ava/gemini/stream` endpoint. Preserve the current tool loop as a second phase: if the first response contains a recognized tool call, stop displaying it as a final answer, run the local tool, then stream the follow-up answer with a visible status.
2. Render the assistant bubble immediately on `request_started`, show “Connecting…” only for the first short interval, and replace it with the first delta. Do not show “thinking” as the only state for the whole request.
3. Add a cancel button and client-side deadline. Cancellation must release any reservation and close the SSE connection without leaving `_busy` stuck.

### P0 — switch and pin one fast text model

1. Change the personal text default in `openRouterModel()` to `deepseek/deepseek-v4-flash` only when the model is confirmed to support the required streaming response shape and low-latency settings.
2. Set the production environment override to the same model and remove stale GLM/Kimi defaults from the personal chat lane. Keep the Messenger agent model separate until the fast/agent split is complete.
3. Add a fast fallback with a strict pre-first-token deadline. Retry only before any bytes are sent; never wait for a second full model response after streaming has begun.
4. Keep `MAX_TOKENS` tight for ordinary chat (for example 300–400, with an explicit “answer in more detail” path), rather than paying/ waiting for a 700-token ceiling on every turn.

### P0 — remove avoidable serial preflight from the first-token path

1. Start independent work in parallel: premium/entitlement resolution, email lookup, and any safe configuration lookup.
2. Do not block the first response on a full semantic memory search. Start the stream with a short fast-chat context, then use one of these safe patterns:
   - prefetch the top memory candidates while the composer is idle;
   - use a bounded local cache of recent confirmed profile facts;
   - run recall in parallel with provider connection setup and inject only if the provider has not started sending;
   - for a true fast lane, answer immediately and offer “Search my memory” as an explicit second action.
3. Keep private-content consent enforcement before any excerpt leaves the device. Faster must not mean bypassing the memory boundary.
4. Cache stable system prompts, model configuration and connector metadata. Never cache user-specific answers across accounts.

### P1 — make the agentic lane honest and bounded

1. Add a cheap intent classifier/allow-list for tool requests. Normal conversation must bypass `runAgentLoop()`.
2. For tool work, send an immediate status event such as “Checking Calendar…” and show the current step; do not label tool execution “thinking.”
3. Set a per-turn wall-clock budget and a lower per-step timeout for ordinary tool reads. Stop after the budget with a resumable result rather than allowing a 45-second step to dominate the UX.
4. Limit tool rounds by capability: simple read ≤2 model rounds; compound workflows may use the existing larger budget but must disclose that they are working.
5. Preserve accumulated tool results, but trim old results before every subsequent call. The existing `ctx_trim` path helps; expose its effect in telemetry.

### P1 — control reasoning explicitly

1. Add a provider-neutral `latency_profile: fast|balanced|deep` to the request contract.
2. Map `fast` to the chosen provider’s supported low/no-reasoning setting. Do not rely on “do not think” in the system prompt.
3. Reject unsupported combinations at the gateway rather than silently falling back to a model that reasons longer.
4. Store `reasoning_mode` and `reasoning_tokens` where the provider reports them. If a provider does not report them, record `unknown`, not zero.

### P1 — instrument time-to-first-token

Every AI request must emit one correlated trace with:

`request_started_ms`, `auth_done_ms`, `config_done_ms`, `entitlement_done_ms`, `recall_started_ms`, `recall_done_ms`, `reserve_done_ms`, `provider_started_ms`, `first_delta_ms`, `stream_completed_ms`, `total_ms`, `model`, `provider`, `fallback_used`, `tool_rounds`, `memory_hits`, `memory_latency_ms`, `reasoning_mode`, `status`, `error_code`, `app_build`, `environment`, `uid`, and the approved email identifier.

For PostHog, add or standardize:

- `avabrain_turn_started`
- `avabrain_first_token`
- `avabrain_turn_completed`
- `avabrain_turn_blocked`
- `avabrain_provider_fallback`
- `avabrain_tool_round`
- `avabrain_recall_completed`
- `$ai_generation` with `$ai_model`, `$ai_provider`, `$ai_latency_ms`, `$ai_time_to_first_token_ms`

Never include message text, prompts, transcripts, file contents, auth headers or raw media URLs.

## 33. PostHog verification plan for `hdavy2002@gmail.com`

When the connector is available, query the account over the last 14 days and segment by `surface`/`source`:

1. `ava_chat_request` → `ava_chat_completed`: total, setup, gen and client latency.
2. `ava_reason_call`: provider, model, fallback, latency, cache hit and token counts.
3. `ava_thread_completed`: Messenger agent latency, `steps`, `tool_rounds`, fallback reason and model.
4. `avachat_turn_sent` → `avachat_turn_replied`: client-perceived companion latency.
5. New first-token events: p50/p90 TTFT by model and route.
6. Error and timeout events: 429, 5xx, stream disconnect, empty response, reserve failure.

The diagnosis to confirm is:

- Ask Ava has high perceived latency because it is buffered/non-streaming;
- Companion TTFT is dominated by pre-stream memory/setup plus the current OpenRouter model;
- Messenger agent latency is dominated by tool rounds or fallback retries for requests that should have used fast chat;
- “Thinking” duration correlates with provider/model time, not Flutter rendering.

## 34. Acceptance criteria for a fast experience

1. Ordinary text chat shows a visible assistant bubble before the full answer completes.
2. p50 time-to-first-token is ≤1.5s and p95 ≤3s for fast chat in staging, measured separately from total completion time.
3. Ask Ava and Companion use the same fast text model and streaming contract; no hidden buffered path remains for ordinary text.
4. 95% of ordinary text turns use one model call and zero tool rounds.
5. Memory recall is either parallelized, prefetched, or explicitly deferred; it is never an unmeasured serial blocker.
6. A provider failure before first token falls back within the deadline; after first token, the UI continues or ends truthfully without replaying the whole request.
7. “Thinking” is replaced by specific states: Connecting, Answering, Checking Calendar, Searching memory, or Unable to connect.
8. PostHog can identify the exact slow span for `hdavy2002@gmail.com` without inspecting private content.

## 35. Issue ownership

- `[AVA-FAST-STREAM-1]` — streaming Ask Ava and shared client state machine;
- `[AVA-FAST-MODEL-1]` — model pin, low-reasoning profile and fallback deadline;
- `[AVA-FAST-PREFLIGHT-1]` — parallel/prefetched memory and entitlement setup;
- `[AVA-AGENT-BOUNDED-1]` — intent split, tool status and round/time budgets;
- `[AVA-TTFT-OBS-1]` — first-token telemetry and PostHog dashboard;
- `[AVA-FAST-UX-1]` — truthful progress states, cancel and retry behavior.

No production model or flag change should be made until the staging acceptance criteria pass and the PostHog trace proves whether the delay is preflight, provider TTFT, tool rounds, fallback, or client rendering.

---

# Part VI — Media jobs, file actions, and AvaBrain retrieval

## 36. Executive finding

The requested ChatGPT-like experience is partly present in the Flutter UI, but the system does not have one durable, resumable AI-job abstraction. It has several disconnected mechanisms:

1. Image generation posts a generic persisted `ava_status` row, then posts a separate finished image later.
2. The client removes **all** `ava_status` rows when an Ava answer arrives. A later text answer can therefore erase the image placeholder even though the image job is still running.
3. PDF summarize/translate currently returns inline text or posts a private-lane result; it does not consistently create a new file artifact.
4. Audio transcription exists for short voice input, but there is no durable “audio → transcript file” or “audio → translated audio file” job pipeline.
5. AvaBrain media indexing is incomplete: the consented media-memory consumer handles audio/video, but images and PDFs are not covered by the same searchable ingestion contract. Video frame captioning is currently a no-op in the Workers runtime.

This is why individual UI fixes keep recurring. The permanent fix is a single `AiMediaJob` state machine used by image generation, document operations, audio transcription, audio translation, and future video work.

## 37. Image generation: exact root cause and required UX

### Evidence

- `worker/src/routes/ava_image.ts` creates `ava_status` with `phase:start`, runs detached work, posts a separate `ava` message containing `media_ref`, and finally posts `phase:end`.
- `app/lib/features/avatok/chat_thread.dart` removes every `ava_status` when a streamed or durable Ava answer arrives. It does not correlate removal by `status_id`.
- The image placeholder widget and finished-image overflow menu already exist, but they are attached to a transient status row rather than one durable message/job.
- `worker/src/lib/composio.ts` deliberately runs an image fast path and tells the model to acknowledge while the image is generated. That is correct conceptually, but it is not coupled to a durable placeholder.

### Permanent design

Create one persisted message-backed job at request time:

```text
message_id / job_id
kind: ai_image
status: queued | running | succeeded | failed | cancelled
prompt_summary
progress_label
media_ref (nullable)
error_code (nullable)
created_at / updated_at / completed_at
owner_uid / conversation_id / scope
```

The initial message must render immediately as a fixed-size image card saying “Working on your image…”. It must remain in the scrollback while later messages arrive. On success, update that same card with the image and caption; do not append an unrelated surprise image. On failure, update the card with a retry action and a truthful error. On reconnect, hydrate the job from the server and resume polling/SSE. Correlate every update by `job_id`; never remove all status rows globally.

The finished image must support Open, full-screen zoom, Download full resolution, Share, Save to AvaStorage, and Delete. The download action must fetch the original R2 object, not the 240px CDN rendition. Generation must remain paid and reserve/settle exactly once; failed jobs release the reservation and must not charge.

Issue: `[AVA-MEDIA-JOB-1]` — durable job/message state and idempotent transitions.

Issue: `[AVA-IMAGE-UX-1]` — persistent placeholder, same-card replacement, reconnect, retry, full-resolution actions.

Issue: `[AVA-IMAGE-BILLING-1]` — one reservation/settlement ledger entry keyed by job ID.

## 38. PDF and document actions

`app/lib/features/ava/ava_doc_actions.dart` already exposes Summarize and Translate, including a language picker and an asynchronous translate-file endpoint. However, summarize and inline translate are not artifact-producing operations, and the action menu is not capability-driven.

Required right-click menu for PDFs/documents:

- Summarize → create `original-name.summary.md` or `.txt`.
- Translate → choose language → create `original-name.<language>.pdf` or `.txt`.
- Copy result / Open result / Download / Save to AvaStorage / Delete result.
- Show a grey file card immediately: “Preparing summary…” or “Translating to Hindi…”.
- Replace the placeholder with the new file when complete; preserve the original file unchanged.

Do not promise a PDF if the renderer cannot preserve fonts/layout. The artifact contract must report the actual MIME type and extension. Non-Latin output must use embedded fonts or be emitted as UTF-8 text/HTML, never silently corrupted Latin-1 output.

All document jobs must be server-authorized, account-scoped, paid, idempotent, cancellable, resumable, and capped by input bytes/pages. The current 45-second client timeout must not define job lifetime; it should only end the foreground wait while the job continues.

Issue: `[AVA-DOC-ARTIFACT-1]` — capability menu plus durable summary/translation artifacts.

Issue: `[AVA-DOC-BILLING-1]` — reserve before work, settle on output bytes/model usage, refund on failure.

## 39. Audio transcription and translated audio

The existing `/api/stt/transcribe` route is a useful base: it uses `openai/whisper-large-v3`, accepts multilingual audio, and currently returns text without persisting an output artifact. Voice-note helpers mainly display inline results. They do not implement the requested file workflow.

Recommended capability pipeline:

```text
audio file
  ├─ transcribe ──> transcript.txt / .md
  └─ translate ──> Whisper transcript
                  → fast text translation
                  → TTS audio in selected language
                  → translated-audio file
```

Recommended initial models:

- STT: `openai/whisper-large-v3` through OpenRouter. OpenRouter currently lists it at $0.0015/minute and supports 99+ languages; retain `groq/whisper-large-v3-turbo` as a latency fallback only after measuring language quality.
- Translation: the selected paid attachment/text-processing model from the capability router, with reasoning disabled. Do not use the free text-chat lane for attachment work.
- TTS: use the existing server-side TTS adapter first. If an OpenRouter TTS model is introduced, pin one multilingual production model and record its actual provider usage; do not estimate audio cost from characters alone.

OpenRouter describes DeepSeek V4 Flash at roughly $0.09/$0.18 per million input/output tokens, but the effective provider price changes. The billing service must read provider usage and apply the requested 20% markup, rather than hardcoding a “per audio file” amount. See the current model page: https://openrouter.ai/deepseek/deepseek-v4-flash/pricing and Whisper page: https://openrouter.ai/openai/whisper-large-v3/pricing.

UX requirements:

- Right-click audio → Transcribe, Translate, Download transcript, Save.
- Translate opens a language picker before the job starts.
- Immediately create a grey audio/file placeholder with “Converting to text…” or “Translating to Spanish…”.
- Keep the placeholder in the chat while the user continues chatting.
- On success replace it with a playable audio/file card, duration, language, transcript link, download, and share.
- On failure show Retry and Refund status. Never lose the original audio.

Issue: `[AVA-AUDIO-ARTIFACT-1]` — durable audio job state, transcript artifact, translated-audio artifact and playback UI.

Issue: `[AVA-AUDIO-FAST-1]` — short-clip fast path, background queue for long files, progress/ETA and reconnect recovery.

## 40. AvaBrain: what is and is not possible

AvaBrain should search the user’s own authorized history and files, not act as an unrestricted visual-sexual search engine. A vague description of a third party’s intimate image must not cause Ava to infer, generate, or retrieve a similar explicit image. The safe product boundary is:

- Search only media owned by or explicitly shared with the requesting account.
- Never search another user’s private media or expose a private contact’s intimate content.
- Require an explicit adult-content/privacy setting before indexing sensitive media.
- Keep sensitive captions/embeddings account-scoped and encrypted; do not place raw captions or image URLs in analytics.
- Allow exact retrieval of the user’s own file by its stored metadata, caption, date, conversation, sender, and approved semantic index.
- If the user wants a description-only upload flow, treat it as an additional user-provided hint, not a replacement for indexing. A title alone cannot reliably find an image later by visual content.

### Required ingestion contract

Every eligible upload should create an `AvaMemoryAsset` record:

```text
asset_id, owner_uid, media_id, source_conversation, source_message
kind, mime, title, user_description, language, created_at
transcript_ref, extracted_text_ref, caption_ref, embedding_ref
consent_version, sensitivity_class, index_status, deleted_at
```

- Images: optional paid vision caption/OCR/object-label pass, followed by embeddings. Store safe searchable concepts and a sensitivity class; do not store explicit descriptions in PostHog.
- Audio: paid Whisper transcription, language detection, transcript indexing, and optional speaker/time metadata.
- PDFs: text extraction, page-aware chunking, OCR fallback, embeddings, and source-page references.
- Video: first ship user title/description plus audio transcription and basic metadata. Do not claim visual search until a real frame-sampling worker exists. If later enabled, sample sparse frames, deduplicate near-identical frames, and bill by duration/frames.

The current `consumers/src/brain.ts` audio/video path and `worker/src/routes/brain_media.ts` consent gates are useful foundations, but images/PDFs need to join the same asset/index lifecycle. The current video caption function returning zero frames is a known capability gap, not a completed feature.

### AvaBrain/Messenger coordination

Messenger remains the source of message/media ownership; AvaBrain maintains derived, deletable indexes. A single `media_id` must link the chat attachment, storage object, job, artifact, and brain index. Deleting or revoking consent must enqueue deletion of every derivative. AvaBrain search results must return a stable media ID and open the original Messenger/AvaStorage item, never a copied blob.

Issue: `[AVABRAIN-ASSET-1]` — canonical cross-surface asset and derived-index schema.

Issue: `[AVABRAIN-INGEST-1]` — image/PDF/audio ingestion, consent, deletion and reindexing.

Issue: `[AVABRAIN-SEARCH-1]` — account-scoped semantic + metadata search with source links and confidence.

Issue: `[AVABRAIN-VIDEO-1]` — explicitly mark visual video search unavailable until frame analysis is implemented.

## 41. Billing rule for all paid media capabilities

Text-only Messenger and AvaBrain conversation is free. Everything that processes or creates a file is paid: image generation, image understanding, PDF extraction/summarization/translation, audio STT, audio translation, TTS, OCR, embeddings, and future video analysis.

The capability router must attach:

```text
capability, model, provider, usage_units, provider_cost_usd
markup = 20%
wallet_debit = provider_cost_usd * 1.20
job_id, reservation_id, settlement_id
```

Use integer micro-USD internally, round only at the wallet boundary, and show the user the operation and estimated cost before expensive jobs. Never call a paid provider before the reservation succeeds. Never debit from a transient client estimate. Refund unused reservation on failure/cancellation and make settlement idempotent by `job_id`.

This must use the corrected spendable-wallet authority from Part I; attachment jobs must not repeat the `reserve()` paid-balance bug that caused the current 402 outage.

## 42. Build order and permanent acceptance tests

1. `[AVA-MEDIA-JOB-1]` shared job/message state machine, event schema, reconnect and idempotency.
2. `[AVA-IMAGE-UX-1]` image placeholder replacement and full-resolution actions.
3. `[AVA-DOC-ARTIFACT-1]` PDF actions producing new files.
4. `[AVA-AUDIO-ARTIFACT-1]` STT and translated-audio artifacts.
5. `[AVABRAIN-ASSET-1]` unified asset/index links, consent and deletion.
6. `[AVA-DOC-BILLING-1]` capability pricing, 20% markup and corrected wallet settlement.
7. `[AVABRAIN-SEARCH-1]` retrieval evaluation using synthetic, account-scoped fixtures.

Acceptance tests must prove:

- A user can send five follow-up messages while an image/audio/document job runs; the placeholder stays in place and updates the correct card.
- App kill, reconnect, duplicate webhook, provider timeout, and worker retry do not duplicate artifacts or charges.
- Every completed artifact opens, downloads at original quality, and links back to its source.
- Original media is never overwritten or deleted by a derived operation.
- Cross-account queries return zero results, including after logout/login on a shared device.
- Revoking AvaBrain consent removes derived indexes while preserving the original file.
- PostHog records job timing, model, provider, usage, status and error code, but never prompts, transcripts, captions, intimate labels or raw media URLs.
- Free text chat never reserves wallet tokens; every file capability does.

No production implementation should begin until the job schema, wallet settlement contract, privacy boundary, and staging acceptance tests are agreed. The durable fix is one state machine and one asset identity—not more special-case chips or per-feature timers.

---

# Part VII — Exact implementation handoff for the next AI agent

This section is intentionally file-specific. An implementing AI must follow this order, edit only the listed files for each issue, and must not “solve” the problem by adding another temporary status chip or by changing a production flag.

## 43. Files to add first

Create these files:

1. `worker/src/lib/ai_media_jobs.ts`

   Canonical server job service. Add types and functions:

   - `AiMediaJobKind`: `image_generate`, `doc_summarize`, `doc_translate`, `audio_transcribe`, `audio_translate`.
   - `AiMediaJobStatus`: `queued`, `running`, `succeeded`, `failed`, `cancelled`.
   - `createAiMediaJob()` — validates owner/conversation/media scope, creates the placeholder record and reserves billing.
   - `claimAiMediaJob()` — atomic queued → running transition.
   - `completeAiMediaJob()` — atomic running → succeeded transition and artifact link.
   - `failAiMediaJob()` — records a safe error code and releases/refunds reservation.
   - `cancelAiMediaJob()` — owner-authorized cancellation.
   - `getAiMediaJob()` and `listAiMediaJobs()` — account-scoped reconnect/hydration APIs.

   Every transition must be idempotent by `job_id`. Do not put provider prompts, file contents, transcripts or sensitive captions in the job table.

2. `worker/src/routes/ai_media_jobs.ts`

   Add authenticated endpoints:

   - `POST /api/ai/jobs` — create a job.
   - `GET /api/ai/jobs/:job_id` — retrieve one job for the owner.
   - `POST /api/ai/jobs/:job_id/cancel` — cancel.
   - `GET /api/ai/jobs?conv=...` — reconnect pending jobs for a conversation.

   Return only safe metadata: job ID, kind, status, label, progress, artifact ID/ref, timestamps and error code. Reject another account’s `uid`, `conv`, `media_id` or job ID.

3. `worker/src/queues/ai_media.ts`

   Add the background consumer/queue handler. Dispatch by job kind to existing services. It must claim before work, use provider timeouts, retry only retryable errors, and call `completeAiMediaJob()` or `failAiMediaJob()` exactly once.

4. `worker/migrations/2026-07-25-ai-media-jobs.sql`

   Add tables:

   - `ai_media_jobs(job_id, owner_uid, conv_id, source_media_id, kind, status, label, progress, artifact_media_id, error_code, reservation_id, created_at, updated_at, completed_at)`.
   - `ai_media_artifacts(artifact_id, owner_uid, source_media_id, job_id, media_id, mime_type, file_name, language, created_at)`.
   - Unique constraints on `job_id` and `(job_id, artifact_media_id)`.
   - Indexes on `(owner_uid, status, updated_at)` and `(owner_uid, conv_id, created_at)`.

   Do not add a second wallet or media table. Link artifacts to the existing `user_media`/media storage records.

5. `app/lib/core/ai_media_jobs.dart`

   Add the Flutter client model and repository: `AiMediaJob`, `AiMediaJobStatus`, `AiMediaJobRepository`, polling/SSE reconciliation, scoped local cache, retry, cancel and duplicate-event suppression. All local keys must use `scopedKey()`/`AccountScope.id`.

6. `app/lib/features/avatok/widgets/ai_media_job_card.dart`

   Add reusable cards for image, document and audio jobs. States must be visibly distinct: Working, Ready, Failed and Cancelled. The card must not disappear when a later chat message arrives.

## 44. Exact files to edit for image generation

Edit:

- `worker/src/routes/ava_image.ts`
  - Replace `postChip()`/`endChip()` as the primary state mechanism with `createAiMediaJob()` and job events.
  - Keep `runAvaImage()` as the entry point, but return `job_id` immediately.
  - Make `fulfil()` claim and complete the job; store the generated image as an artifact linked to the job.
  - Use the existing wallet authority and settle once by `job_id`.
  - On provider failure, update the same job to `failed`; do not append an unrelated failure message.

- `worker/src/lib/composio.ts`
  - Keep the image fast path and `generate_image` tool.
  - Change the tool result to return `{job_id, status:"queued"}` and a short acknowledgement.
  - Do not make the model wait for image generation.

- `worker/src/index.ts`
  - Register `ai_media_jobs.ts` routes and the queue consumer. Follow the existing route/queue registration style.

- `app/lib/features/avatok/chat_thread.dart`
  - Subscribe to `AiMediaJobRepository` for the current conversation.
  - Render `AiMediaJobCard` for image jobs.
  - Delete the global `removeWhere((m) => m.special == 'ava_status')` behavior at the two answer-arrival sites (around the existing local-Ava and streamed-Ava handlers). Replace it with removal/update by matching `job_id` only.
  - Retain `_avaImageBubble()` and `_openImageFull()`, but move the overflow menu into the job card’s succeeded state.
  - Do not delete the existing image widget until the replacement card is verified.

- `app/lib/features/ava_generative/image_tool.dart`
  - Consume the returned `job_id` and insert the local pending card immediately.
  - Remove any independent “image pending” state that cannot survive reconnect.

Do not edit `worker/dist-staging/index.js`; it is generated output.

## 45. Exact files to edit for PDF/document actions

Edit:

- `app/lib/features/ava/ava_doc_actions.dart`
  - Replace inline-only summarize/translate handling with job creation.
  - Add menu items for `Summarize` and `Translate` that always produce a new artifact.
  - Keep the language picker, but pass `target_language` into the job.
  - Add Open, Download, Share, Save and Delete actions for the resulting artifact.
  - Remove the 45-second timeout as the operation lifetime; it may only bound the foreground request.

- `app/lib/features/avatok/chat_thread.dart`
  - Pass PDF/document media IDs into `AvaDocActions`.
  - Render pending document cards and refresh them from the job repository.

- `worker/src/routes/ava_copilot.ts`
  - Keep the existing text extraction and translation logic as worker functions, but call them from the job consumer.
  - Change `translate-file` from “post a private-lane result” to “create and register a new artifact, then complete the job.”
  - Add paid capability authorization before extraction/provider calls.
  - Ensure Unicode output uses embedded fonts or UTF-8 text/HTML; never silently emit corrupted Latin-1 PDF output.

- `worker/src/routes/media.ts`
  - Add the artifact registration path through the existing media pool and content-addressed storage.
  - Preserve the original file and link the derived file with `source_media_id`.

Do not delete `ava_copilot.ts`’s existing extraction functions; move orchestration around them and keep them covered by tests.

## 46. Exact files to edit for audio transcription/translation

Edit:

- `worker/src/routes/stt.ts`
  - Keep `openai/whisper-large-v3` as the default multilingual model.
  - Export a worker-callable transcription function instead of making the job consumer call the HTTP route internally.
  - Return provider usage, detected language and duration for billing.
  - Keep the HTTP route for short voice input, but route durable file jobs through `ai_media_jobs.ts`.

- `app/lib/features/avatok/chat_thread.dart`
  - Extend the existing voice/file context menu to include `Transcribe` and `Translate`.
  - Add a language picker for translation.
  - Create a pending job card immediately and never replace/remove the source audio.

- `app/lib/core/audio_playback_service.dart`
  - Add playback support for completed translated artifacts and preserve duration/position state by artifact media ID.

- `worker/src/lib/ava_reason/policy.ts`
  - Add capability mappings for `audio_translate`, `audio_transcribe`, `doc_summarize`, `doc_translate`, and `image_understanding`.
  - Pin model IDs and latency profiles here; do not scatter model strings through routes.

- `worker/src/lib/ava_reason/core.ts`
  - Return actual provider usage and cost inputs to the billing layer.
  - Do not fabricate token counts when the provider does not report them.

- `worker/src/lib/ava_reason/adapters/openrouter.ts`
  - Add the selected paid attachment model and explicit low-reasoning/fast parameters.
  - Preserve the current free text-chat model path separately.

Add a TTS adapter only if the existing server-side voice adapter cannot synthesize the requested target language. Prefer extending the existing adapter over adding a second audio stack.

## 47. Exact files to edit for AvaBrain indexing

Create:

- `worker/src/lib/brain_assets.ts` — canonical `AvaMemoryAsset` type, consent checks, source links, index status and derivative deletion.
- `consumers/src/brain_assets.ts` — queue consumer for image captions/OCR, PDF extraction, audio transcript indexing and embeddings.
- `worker/migrations/2026-07-25-brain-assets.sql` — `brain_assets`, `brain_asset_derivatives`, consent/version fields and account-scoped indexes.
- `app/lib/core/brain_assets_client.dart` — upload/prepare/complete/index-status client and scoped cache.

Edit:

- `worker/src/routes/brain_media.ts`
  - Extend the existing consented media flow to reference `brain_assets` and job IDs.
  - Do not expose raw transcript/caption content in status responses.

- `consumers/src/brain.ts`
  - Reuse `transcribeBuffer()` for audio.
  - Replace the current metadata-only/zero-frame video behavior with an explicit `unsupported_visual_indexing` status; do not claim video visual search works.
  - Add image/PDF dispatch through `brain_assets.ts` rather than placing all logic in this file.

- `worker/src/routes/brain.ts` and `worker/src/routes/brain_domains.ts`
  - Make search return `media_id`, source conversation/message, confidence and a safe display title.
  - Enforce owner scope and consent at query time, not only ingestion time.

- `app/lib/core/brain_recall.dart`
  - Resolve search hits back to Messenger/AvaStorage using `media_id`.
  - Never open a copied or unscoped URL.

- `app/lib/core/brain_consent.dart` and `app/lib/features/avabrain/brain_settings_screen.dart`
  - Add separate controls for file indexing, image analysis, audio transcription and sensitive-media indexing.
  - Default according to the existing product rulebook; provide a clear revoke/delete-derived-index action.

Do not implement retrieval of another person’s private or intimate media. Search must remain limited to the authenticated user’s own or explicitly shared assets.

## 48. Exact billing files to edit

Edit:

- `worker/src/lib/ai_billing.ts` — this file already exists; extend and consolidate it.
  - Keep `reserveAiJob()`, `settleAiJob()` and `releaseAiJob()` as the canonical public API; do not create a second parallel naming layer.
  - Replace per-request `ceil(...tokens)` settlement with cumulative account-level micro-USD debt.
  - Apply `provider_cost_micro_usd * 1.20` only to usage-priced paid capabilities.
  - Read actual usage from provider responses; do not use a fixed “tokens per image/audio” estimate.
  - Remove or migrate the dead duplicate usage-pricing implementation in `worker/src/feature_pricing.ts` after proving it has no call sites.

- `worker/src/do/wallet.ts`
  - Add an explicit `allow_free`/spendable policy to the AI reservation path.
  - Do not change campaign escrow semantics.

- `worker/src/routes/ava_copilot.ts`, `worker/src/routes/stt.ts`, `worker/src/routes/ava_image.ts`
  - Remove direct or duplicated billing decisions and call `ai_billing.ts`.

- `worker/migrations/2026-07-24-ai-billing-ledger.sql`
  - Extend the ledger only if its schema cannot already represent `job_id`, capability, provider usage, reservation and refund. Prefer a new additive migration over rewriting existing rows.

- `app/lib/core/wallet_topup_billing.dart`
  - Display the preflight estimate and final debit/refund state from the server; never calculate the authoritative debit locally.

Do not turn `aiWalletMeteringEnabled` off globally. Text-free behavior belongs in the capability router; attachments must remain metered.

## 49. Files to retire or remove after migration

Only remove these after the new path is live in staging and tests pass:

- The `postChip()`/`endChip()` image-only persistence path in `worker/src/routes/ava_image.ts`.
- Generic client-wide `ava_status` cleanup in `app/lib/features/avatok/chat_thread.dart`.
- Inline-only document result dialogs in `app/lib/features/ava/ava_doc_actions.dart` once artifact cards replace them.
- Duplicate audio translation/transcription billing or route-specific model selection.

Do not delete generated `worker/dist-*` files manually, and do not delete the original media or existing extraction/transcription helpers.

## 50. Required implementation sequence

An AI implementing this specification must work in separate, reviewable issues:

1. `[AVA-MEDIA-JOB-1]` migration, server job service, routes, queue, Flutter repository and generic card.
2. `[AVA-IMAGE-UX-1]` migrate image generation to the durable job card; remove global status deletion.
3. `[AVA-DOC-ARTIFACT-1]` migrate PDF summarize/translate to derived artifacts.
4. `[AVA-AUDIO-ARTIFACT-1]` add transcript and translated-audio artifacts.
5. `[AVABRAIN-ASSET-1]` add the unified asset/index lifecycle and consent deletion.
6. `[AVA-BILLING-20-1]` centralize reservations, actual usage settlement and 20% markup.
7. `[AVABRAIN-SEARCH-1]` connect Brain search hits to Messenger/AvaStorage.

For each issue: edit only its listed files, add tests, run no local build, update `graphify` after code changes, and validate through GitHub Actions in staging. Do not deploy or change production flags unless explicitly authorized.

---

# Part VIII — Verified corrections to the billing/flag audit

## 51. Verdict on the quoted audit

The central findings are confirmed directly in source:

- `microUsdToTokens()` rounds every non-zero sub-cent charge up to one wallet token.
- `reserve()` admits only against paid `balance`; `consumeReserved()` deducts only paid `balance`.
- `reserve()` has no required `allow_free` policy.
- `receptionist.ts:1016` and `pstn.ts:259` still read paid balance rather than spendable funds.
- `imageGenEnabled` is a client-only name while the Worker uses `generativeEnabled`.
- `imageDailyCap` is missing from `numericKeys`.
- `MoneyApi.balance()` discards status and callers commonly interpret missing fields as zero/false.
- `AI_MARKUP_BPS` does not reprice flat `FEATURE_COSTS`; `feature_pricing.ts` also contains a separate stale 1.30 usage-pricing path.

Corrections to the audit itself:

1. The “~340,000 image lookups” claim is not supported by its own example. The correct figure is about 8,333 at the stated image-understanding cost and 20% markup.
2. Adding `imageDailyCap` to `numericKeys` does not activate the cap. The image route does not read it.
3. Preserving status in `MoneyApi` does not by itself stop false paywalls. Callers must represent entitlement as `premium | free | unknown`, and `unknown` must never render as “not premium” or “0 tokens.”
4. Making `allow_free` “required” only creates a compile-time safety net if the wallet operation is strongly typed. Today `walletOp(..., op: object)` and the DO body `any` allow omissions to compile.
5. Micro-USD debt and reservation settlement must be one atomic WalletDO operation. Implementing debt only in `ai_billing.ts` creates races between simultaneous jobs.

## 52. Exact wallet fix — one commit, no partial deployment

Issue: `[AI-WALLET-SPENDABLE-2]`

Edit `worker/src/routes/wallet.ts`:

- Replace `walletOp(..., op: object)` with a discriminated `WalletOperation` union.
- Add typed operations for `reserve`, `consume_reserved`, `release_reservation`, and the new `settle_ai_cost`.
- Require `allow_free: boolean` on both `reserve` and `consume_reserved`.
- Change `walletReserve()`/`walletConsumeReserved()` campaign helpers to pass `allow_free:false`.
- Reject a missing `allow_free` at runtime too, so old clients/generated code fail safely with 400.

Edit `worker/src/do/wallet.ts`:

- Add `debt_micro_usd INTEGER NOT NULL DEFAULT 0` to the DO-local `acct` schema using the same additive schema-upgrade pattern used for `bonus`.
- Change `reserve()` admission:
  - `allow_free:false` → paid `balance` only.
  - `allow_free:true` → `free + bonus + balance`.
  - **First safe release:** subtract **all outstanding reservations** from both headrooms. Do not use same-policy-only subtraction: an AI reservation and campaign escrow can both ultimately draw paid balance.
  - A later optimization may use the asymmetric formula in §58 only after property tests prove no cross-policy over-commit. It is not required for launch.
- Persist reservation policy on each `resv` row (`allow_free`), and reject attempts to consume a reservation under a different policy.
- Add `expires_at` to AI reservation rows. Require the caller to supply a bounded expiry appropriate to the job; campaign reservations retain their existing explicit lifecycle and are never reaped as AI jobs.
- Whenever an AI reservation is created or extended, schedule the WalletDO alarm for the earliest of: reservation expiry, pending earning hold, or audit-outbox retry.
- Change `consumeReserved()`:
  - `allow_free:false` → paid only.
  - `allow_free:true` → deduct `free`, then `bonus`, then paid `balance`, exactly like `spend()`.
- Add an atomic `settle_ai_cost` operation:
  - validate the active `allow_free:true` reservation;
  - add actual marked-up micro-USD cost to `acct.debt_micro_usd`;
  - calculate whole tokens due;
  - consume no more than the reservation and available spendable funds;
  - deduct free → bonus → paid;
  - keep `debt_micro_usd` as a **remainder only**, with the invariant `0 <= debt_micro_usd < 10,000`;
  - if actual cost exceeds reserved/available funds, record the difference as `unrecovered_micro_usd` in the AI billing ledger and platform telemetry; do **not** carry it as hidden user debt and do not consume a future top-up;
  - record one idempotent result keyed by settlement `op_id`.
- Update `hardReset()` to set `debt_micro_usd=0`, release AI reservations, and record the cleared remainder in its audit metadata. A hard reset means a genuinely fresh grant.
- Update the account-deletion cascade to remove/clear WalletDO AI remainder and reservations. Do not leave debt-like state after account erasure.
- Never use `settle_ai_cost` for campaign escrow, payouts, seller earnings or other transferable value.

Edit `worker/src/lib/ai_billing.ts`:

- Set the usage-priced markup to 120 only as part of this complete change.
- Reserve whole-token headroom based on `existing debt + worst-case marked-up estimate`; do not hardcode a one-token reservation.
- Pass `allow_free:true`.
- Replace `consume_reserved` settlement with `settle_ai_cost`.
- Continue preferring provider-reported `usage.cost`; use catalog estimation only when usage cost is unavailable and record `cost_source`.
- Return `charged_tokens`, `debt_micro_usd_before`, `debt_micro_usd_after`, `provider_cost_micro_usd`, and `unrecovered_micro_usd`.
- Evaluate `FREE_CAPABILITIES` before model lookup, catalog lookup, metering and every wallet call. Free text availability must never depend on a price entry.
- Never use `AI_DEFAULT_RATE` as the user’s settlement price.
- For a metered model without a catalog entry, reserve a conservative **capability-specific headroom ceiling only**; do not treat that estimate as a charge.
- After the provider responds:
  - provider `usage.cost` present → settle from that ground-truth cost even when the model was absent from the catalog;
  - no catalog entry and no provider cost → serve the completed result, charge zero, release the reservation and emit `AI_PRICE_UNKNOWN` as platform loss;
  - never break a free-text or fallback-model response because pricing metadata is missing.

Edit all reservation callers in the same commit:

- `worker/src/lib/ai_billing.ts` → `allow_free:true`.
- `worker/src/lib/voice_billing.ts` → `allow_free:true` for AvaBrain voice reservations and top-ups.
- `worker/src/feature_pricing.ts` → migrate callers to `ai_billing.ts`, or pass `allow_free:true` until the dead path is removed.
- `worker/src/routes/wallet.ts` campaign helpers → `allow_free:false`.
- Any new compile failure from the typed union must be resolved by explicitly choosing true/false; do not add a default.

Edit paid-vs-spendable reads:

- `worker/src/routes/receptionist.ts:1016` → read `spendable` with `balance` only as a backward-compatible fallback.
- `worker/src/routes/pstn.ts:259` → same.
- Audit `worker/src/routes/translate.ts`, `avavision.ts`, `avavoice.ts`, `media.ts`, and `wallet_statement.ts`; document whether each is an internal cost (`spendable`) or transferable/withdrawable value (`balance`). Do not mechanically replace all balance reads.

Add tests:

- `worker/test/wallet_reservation_policy.test.ts`
- `worker/test/ai_billing_accrual.test.ts`

Required cases:

- Bonus-only account reserves and consumes one internal-cost token.
- Bonus-only account cannot reserve campaign/payout value.
- Missing `allow_free` returns 400.
- Replaying reserve/settle IDs does not double charge or double debt.
- 100 sub-cent jobs settle cumulatively at the correct 20% batch price.
- Two concurrent jobs cannot spend the same final token.
- A 50-token campaign reservation plus a 50-token bonus/50-token paid wallet refuses an overlapping 60-token AI reservation.
- Failed/released jobs do not add debt.
- A large job can reserve and settle multiple tokens.
- A deliberately underestimated provider result records platform `unrecovered_micro_usd`; it never leaves `debt_micro_usd >= 10,000` and never consumes the next top-up.
- `hardReset()` clears the sub-cent remainder and AI reservations.
- An expired AI reservation is released by a scheduled alarm without requiring another request.
- With `aiWalletMeteringEnabled=true`, both `chat_ava` and `chat_thread` complete without calling WalletDO, writing `resv`, changing `debt_micro_usd`, or creating a wallet transaction.

Do not deploy `reserve()` without `consumeReserved()`, typed call sites, runtime validation and tests in the same commit.

### Unrecovered-cost controls

Edit `worker/src/routes/config.ts`:

- Add numeric `unrecoveredDailyCapMicroUsd` and `unrecoveredPlatformAlertMicroUsd` to `PlatformConfig`, `DEFAULTS` and `numericKeys`.

Edit `worker/src/lib/ai_billing.ts`:

- Track unrecovered cost per account per UTC day.
- Once the account cap is exceeded, block additional **metered** jobs with `AI_UNRECOVERED_LIMIT`; free text remains available.
- Track the platform-wide daily total and page/alert when the platform threshold is crossed.
- Include capability, model, provider, estimate source and actual cost in sanitized loss telemetry.
- For image generation, use a deliberately conservative reserve derived from resolution/provider historical P99 or a configured maximum; refund unused headroom after provider-reported settlement.
- Do not advertise an exact preflight image charge until the selected provider reliably reports the usage unit needed to calculate it.

Add tests proving the per-account UTC reset, platform alert threshold, free-text bypass, image over-reserve/refund, and `AI_UNRECOVERED_LIMIT` behavior.

## 53. Exact entitlement/network fix

Issue: `[WALLET-GET-STATE-1]`

Edit `app/lib/core/money_api.dart`:

- Add a shared `_get()` wrapper returning a typed result containing `ok`, `status`, `data`, and `error`.
- Preserve HTTP status for JSON and non-JSON responses.
- Distinguish transport failure, authentication failure, server failure and valid zero balance.
- Emit one sanitized analytics event with endpoint, status/error class and account identifier already available to the analytics layer.
- Keep a compatibility `balance()` map only temporarily; add `balanceResult()` as the canonical typed API.

Add `app/lib/core/wallet_entitlement.dart`:

- Define `WalletEntitlementState.loading`, `.premium`, `.free`, `.unavailable`.
- Cache the last confirmed state per account using `scopedKey()`.
- A network error may preserve a recently confirmed state for display, marked stale; it must not change premium to free.
- Paid actions must ask the server authoritatively. They must not block solely because a client GET failed.

Update every current `MoneyApi.balance()` entitlement consumer, starting with:

- `app/lib/features/avatok/chat_thread.dart`
- `app/lib/features/avatok/paid_call_prompt.dart`
- `app/lib/features/avalive/live_viewer_screen.dart`
- `app/lib/shell/ava_sidebar.dart`
- `app/lib/core/library_ingest.dart`
- `app/lib/features/avaapps/avaapps_screen.dart`
- `app/lib/features/avachat/voice_call/ai_voice_agent_screen.dart`
- `app/lib/features/settings/sections/receptionist_onboarding.dart`
- `app/lib/shell/v2/home_cards.dart`

Rules:

- `.unavailable` → “Couldn’t verify wallet—try again,” never “top up” and never “0 tokens.”
- `.free` → normal free state.
- `.premium` → premium state.
- Server action 402 remains authoritative and should show the returned needed/spendable values.

Add `app/test/wallet_entitlement_test.dart` covering 200 premium, 200 free, 401, 500, HTML gateway response, timeout and last-known-state behavior.

## 54. Exact feature-flag fix

Issue: `[AI-FLAG-CONTRACT-1]`

Edit `app/lib/core/remote_config.dart`:

- Rename the client getter to `generativeEnabled` and read the exact Worker key `generativeEnabled`.
- Update all client call sites, including `app/lib/features/ava_generative/image_tool.dart`.
- Remove `imageGenEnabled` after no call sites remain; do not keep an alias that can drift again.

Edit `worker/src/routes/config.ts`:

- Add `imageDailyCap` and `livenessValidityDays` to `numericKeys`.
- Add/deal with `aiVoiceCallEnabled` explicitly: either declare it in `PlatformConfig`/`DEFAULTS` and enforce it, or remove the dead client getter. Do not leave an unflippable documented switch.

Edit `worker/src/routes/ava_image.ts`:

- Read `cfg.imageDailyCap` in both `runAvaImage()` and `generateAvaImageSync()`.
- Enforce it as a global per-account/day backstop in addition to the plan allowance, or delete it and make the plan allowance canonical. The report recommends keeping it as the emergency cost circuit breaker.
- Emit `ava_image_global_cap_blocked` with cap, used, tier and environment.

Add `scripts/check-config-contract.mjs`:

- Compare client-read keys with Worker `PlatformConfig`/`DEFAULTS`.
- Verify numeric defaults are listed in `numericKeys`.
- Maintain an explicit allowlist for server-only flags.
- Maintain a source-reader assertion for critical gates/caps (`generativeEnabled`, `imageDailyCap`, `aiWalletMeteringEnabled`) so writable-but-unused flags fail CI.

Edit the existing verification workflow that runs Worker tests to execute this script. Do not edit generated `worker/dist-staging/index.js`.

## 55. Exact free-chat budget fix

Issue: `[AVA-FREE-BUDGET-1]`

Edit `worker/src/lib/ai_gate.ts`:

- Add a per-turn input-token ceiling before guard/model calls.
- Add per-account daily input, output and safety-token budgets; a turn counter remains a secondary anti-script limit.
- Count all safety/moderation model calls and retries against the internal platform-cost budget even though they are never wallet-billed.
- Reject oversized pasted documents from the free text lane and route attachments to the paid document job flow.

Edit `worker/src/routes/config.ts`:

- Add numeric defaults and `numericKeys` entries for `freeTextMaxInputTokens`, `freeTextDailyInputTokens`, `freeTextDailyOutputTokens`, and `freeTextDailyCostMicroUsd`.

Edit `worker/src/routes/ava_gemini.ts`, `worker/src/do/ava_agent.ts`, and `worker/src/routes/ai_chat.ts`:

- Pass measured/estimated input tokens into the shared budget gate before invoking provider or safety models.
- Use the free lane only for text without attachments.
- Emit blocked reason `input_too_large` or `daily_ai_budget_exhausted`, not a wallet/paywall error.

Add `worker/test/ai_free_budget.test.ts` for one oversized turn, many small turns, safety-call accounting, retries and UTC-day reset.

### Request-level idempotency

Edit `app/lib/core/ava_ai_client.dart`, the Messenger Ava send path in `app/lib/features/avatok/chat_thread.dart`, and the companion session client:

- Generate one stable `Idempotency-Key` per logical user message/job, derived from account scope + conversation/session ID + client message ID.
- Persist it in the outbox so timeout, reconnect and manual retry reuse the same key.
- A retry must not mint a new AI job or wallet operation.

Edit `worker/src/routes/ava_gemini.ts`, `worker/src/routes/ai_chat.ts`, `worker/src/do/ava_agent.ts`, and the new media-job route:

- Accept and validate the client key.
- Derive the canonical `opId`/`job_id` from the stable key and authenticated account; do not use a fresh server UUID for a replayed logical request.
- Store/replay the accepted response/job for at least 24 hours for chat and for the full artifact retention period for media jobs.
- Add a test that times out after provider acceptance, retries with the same key, and proves one provider job, one artifact and one charge.

### Reservation expiry and scheduled recovery

Edit `worker/src/lib/ai_billing.ts` and `worker/src/do/wallet.ts`:

- Replace the global six-hour AI TTL with explicit `expires_at`.
- Suggested initial bounds: chat/util reservations 5 minutes; image/document/audio jobs use their declared job deadline plus a short settlement grace period, capped at 60 minutes.
- `reserve()` must schedule the WalletDO alarm immediately. Alarm scheduling must preserve an earlier hold/outbox alarm.
- Reaper events must include capability, age and release reason without prompt content.

### Price-catalog prerequisite

Issue: `[AI-PRICE-CATALOG-1]`

Edit `worker/src/lib/ai_billing.ts`:

- Add every routed model to `AI_PRICE_CATALOG` in the same commit as routing: `deepseek/deepseek-v4-flash`, the selected Gemma vision model, Mistral Nemo, Whisper Large V3, the chosen TTS model, and the chosen image-generation model.
- Remove user billing via `AI_DEFAULT_RATE`.
- Free capabilities bypass the catalog entirely.
- For metered capabilities, an unknown catalog price permits a conservative headroom reserve and provider execution; settlement uses provider `usage.cost`. Only the **charge** fails closed when both verified catalog cost and provider cost are absent, in which case the result is delivered free and `AI_PRICE_UNKNOWN` is alerted as platform loss.
- Prefer provider-reported `usage.cost` for settlement.

Add `worker/src/lib/openrouter_price_catalog.ts`:

- Refresh OpenRouter model pricing into KV on a bounded schedule and cache it for 24 hours.
- Validate modality-specific fields, effective time and model ID before promotion.
- Keep the last verified in-code/KV price as outage fallback; never silently substitute a generic expensive rate.
- Generated-image pricing must use provider-reported image-token usage/cost, not a flat image count.

Add `worker/test/ai_price_catalog.test.ts`:

- Every model returned by `ava_reason/policy.ts` has a verified billable catalog entry or is explicitly free/unmetered.
- Free models/capabilities never invoke catalog or wallet code.
- An unknown metered model with provider `usage.cost` settles correctly; without provider cost it delivers the result, charges zero, releases the reserve and emits the loss alert.
- Catalog refresh cannot replace a valid rate with malformed or zero pricing.

### Prompt caching

Edit `worker/src/lib/ava_reason/adapters/openrouter.ts` and the OpenRouter path in `worker/src/lib/composio.ts`:

- Mark only the stable system/policy prefix as cacheable when the selected provider supports prompt caching.
- Do not cache private per-turn messages, attachment contents, tool outputs or recalled user memory as a shared prefix.
- Record cache-write and cache-read token counts and use the provider’s actual cached-input cost during settlement.
- Treat caching as a cost optimization, never as a correctness dependency; unsupported providers must continue normally.

### Owner pricing decision — resolved

“20% everywhere” is replaced with a precise rule:

- **Usage-priced AI provider work** — model inference, image understanding/generation where usage is reported, OCR, STT, translation and TTS — is charged at actual provider cost plus 20%, settled through cumulative micro-USD accounting.
- **Fixed retail products** — receptionist minute, voicemail, listing publication and other explicitly product-priced services — retain their approved fixed prices. They include infrastructure, telephony, storage, support and product value beyond one model call and are not described as 20%-markup services.
- Remove dead duplicate usage pricing (`AI_MARKUP = 1.30`) from `worker/src/feature_pricing.ts` after call-site verification. Keep `FEATURE_COSTS` only for deliberate fixed retail prices, with comments naming the owner decision/date.

### Staging and production closure verification

Unit tests do not close this incident. After deployment:

1. In staging, use a bonus-only account with `aiWalletMeteringEnabled=true`.
2. Send `hi` through both Ask Ava and Messenger `@ava/#ava`.
3. Confirm a real reply, zero WalletDO operations, zero reservation/debt movement and no wallet transaction.
4. Confirm PostHog shows `ava_chat_request`/completion with no following `api_error status=402`.
5. Only after staging passes, repeat in production with `hdavy2002@gmail.com` on the exact recorded app build.
6. Record timestamp, environment, build, capability, model, PostHog event IDs, wallet before/after and verifier in this report.

The report is not closed until the production check passes. A unit-test-only green build is insufficient.

## 56. Corrected implementation order

1. `[AI-WALLET-SPENDABLE-2]` — typed reservation policy, atomic reserve/consume/accrual settlement, all callers and tests.
2. `[WALLET-GET-STATE-1]` — typed GET result and four-state entitlement consumers.
3. `[AI-FLAG-CONTRACT-1]` — key symmetry, numeric typing, real image-cap enforcement and CI drift test.
4. `[AVA-FREE-BUDGET-1]` — per-turn and daily token/cost budgets, stable request idempotency and scheduled reservation expiry.
5. `[AI-PRICE-CATALOG-1]` — verified prices, provider-cost settlement, conservative unknown-price reserve and unrecovered-cost circuit breakers.
6. `[AVA-FAST-STREAM-1]` — free text model/streaming rollout from Part V, with safe prompt caching.
7. `[AVA-MEDIA-JOB-1]` — durable image/document/audio jobs from Parts VI–VII.
8. Enable metered attachment capabilities in staging only; validate cumulative billing, cross-policy headroom, idempotency, expiry, caps, reconnect and PostHog traces.
9. Run the staging and production closure verification above; record evidence against `hdavy2002@gmail.com`.

Changing `AI_MARKUP_BPS`, relaxing `reserve()`, or flipping image/model flags independently is explicitly prohibited. Each would leave a known correctness or revenue hole.

---

# Part IX — Review of Part VIII: accepted corrections, one defect, four dropped findings

> Response to Part VIII, 2026-07-25. Part VIII is a real improvement on Part III and should be the
> implementation baseline. §57 accepts its corrections. **§58 records and resolves one unsafe rule
> from an earlier Part VIII draft.** §59 lists findings restored into the final baseline.
> work order.

## 57. Corrections accepted — Part III was wrong on these

| Part VIII correction | Verdict |
|---|---|
| The "~340,000 image lookups" figure | **Accepted, Part III was wrong.** 95 tokens = $0.95; at the correct 20% markup an image lookup costs $0.000114, so 95 tokens buys **≈8,333 lookups**, not 340,000. An order-of-magnitude slip. The argument is unaffected — 8,333 vs 95 at the 1¢ floor is still an **≈88× overcharge** — but the number was wrong and Part III should not be quoted for it. |
| `imageDailyCap` needs more than a `numericKeys` entry | **Accepted.** Part III §18 correctly listed it in *both* the ORPHAN list (read by nothing) and the NUMERIC-BROKEN list, then §21 prescribed only the `numericKeys` fix. The finding was right and the remedy did not use it. `routes/ava_image.ts` must actually read it. |
| `MoneyApi` status preservation is not sufficient | **Accepted, and better than Part III's proposal.** Part III said "bring `_json` up to `_post`'s standard," which preserves the status but leaves each caller to invent its own interpretation. A `premium \| free \| unknown \| loading` state with `unknown` never rendering as "not premium" or "0 tokens" is the correct abstraction. |
| A "required" `allow_free` param gives no compile-time safety | **Accepted — this is the sharpest correction in Part VIII.** `walletOp` takes an untyped object and the DO does `body = await req.json()` as `any`, so TypeScript enforcement evaporates at the fetch boundary. A discriminated `WalletOperation` union **plus** a runtime 400 on a missing `allow_free` is required. Part III's suggestion was naive. |
| Accrual must settle atomically inside `WalletDO` | **Accepted, with a sharpened reason.** Durable Objects are single-threaded per object, so two jobs cannot interleave *inside* one DO call. The real race is a Worker-side read-modify-write across two separate `walletOp` round-trips — read debt, compute, write debt — where a second job's settle lands between them. A single `settle_ai_cost` op collapses that window to zero. The conclusion is right; the mechanism is the round-trip, not DO concurrency. |

Part VIII's additive `ALTER TABLE acct ADD COLUMN debt_micro_usd ...` guidance matches the existing self-migrating pattern used for `acct.bonus` (`do/wallet.ts:110`) and for `resv.uid` (`:121`). Correct.

## 58. 🔴 Correctness amendment accepted — cross-policy reservations share paid headroom

An earlier draft of Part VIII §52 said: *"Subtract outstanding reservations of the same policy from the corresponding headroom."*

That is wrong, and it introduces a new revenue hole. Verified against source — `do/wallet.ts:356-359`:

```ts
private outstandingReservations(): number {
  const r = this.sql.exec("SELECT COALESCE(SUM(reserved),0) AS t FROM resv WHERE released=0").one();
  return Number(r.t);
}
```

There is **no policy column on `resv` today**, and the sum is global to the DO. Once two policies exist, "same policy only" lets the same paid token be committed twice:

- Campaign escrow reserves 50 tokens with `allow_free:false`. Those 50 are held against paid `balance`.
- An AI job then reserves with `allow_free:true` and computes headroom as `spendable − Σ(allow_free reservations)`. It **does not see the campaign's 50**, even though `spendable` includes the very `balance` the campaign has already claimed.
- Both settle. Paid balance is over-committed, and the campaign escrow — real, withdrawable money — is the one that loses.

Correct rule, and it is asymmetric because drawdown order is free → bonus → paid:

```
spendableHeadroom = (free + bonus + balance) − Σ(ALL outstanding reservations)
paidHeadroom      = balance − Σ(paid-only reservations)
                            − max(0, Σ(allow_free reservations) − (free + bonus))
```

An `allow_free:true` reserve must clear `spendableHeadroom`. An `allow_free:false` reserve must clear `paidHeadroom`. The conservative simplification — **subtract all outstanding reservations from both headrooms** — is safe, costs a few tokens of unusable headroom in rare overlap, and is what I would ship first.

**Add to `worker/test/wallet_reservation_policy.test.ts`:** with `{balance: 50, bonus: 50}` and an open 50-token campaign escrow, an `allow_free:true` reserve for 60 must be **refused**, not admitted against the campaign's paid tokens.

**Resolution:** Part VIII §52 now specifies the conservative all-reservations rule and the cross-policy test. The asymmetric formula remains a future optimization only.

## 59. Four Part III findings did not survive into Part VIII's work order

Each is independently able to cause a production incident. None appear in §52–§56.

**59a. 🔴 An uncatalogued model bills at ~100× cost.** `rateFor()` falls back to `AI_DEFAULT_RATE` = $5 in / $15 out per 1M for any model absent from `AI_PRICE_CATALOG`. The recommended vision model `google/gemma-3-12b-it` is **$0.05/$0.15** — routing it before cataloguing it charges roughly **100× the real cost**, and unlike the 1¢-floor problem this one scales with request size, so it gets worse on exactly the large requests where the accrual design finally starts working. `deepseek/deepseek-v4-flash`, `gemma-3-12b-it`, `gemma-3-4b-it`, `mistral-nemo` and `gpt-5-image-mini` must all be in the catalog **in the same commit that routes to them**. Better: fetch `/api/v1/models` at runtime, cache 24h in KV, keep the in-code table as fallback — the current table already carries a `google/gemini-3.5-flash` entry marked unverified/TODO, which is what hand-maintained price tables do.

**59b. 🟠 No request-level idempotency — a client retry double-charges and double-generates.** Every path mints `opId = crypto.randomUUID()` server-side per HTTP request (`ava_gemini.ts:295,417`, `ai_chat.ts:89`, `ava_agent.ts:832,927`). Part VIII's test *"replaying reserve/settle IDs does not double charge"* covers replay of the **same** op_id — which WalletDO already handles. It does not cover the actual failure: a client timeout and resubmit mints a **new** op_id, so there is no dedupe at all. The client must send an idempotency key derived from `(threadId, messageId)`, deduped server-side for ~60s. This matters far more once attachments are metered, because those are the requests worth double-charging.

**59c. 🟠 Orphaned reservations can lock a user out of their own tokens for 6 hours.** `AIJOB_RESV_TTL_MS = 6h`. `reapStaleAiJobReservations()` runs lazily at the top of the *next* `reserve()` for that uid and on the DO `alarm()` — but **`reserve()` never schedules an alarm** (only pending holds / audit-outbox do). A Worker that dies between reserve and settle leaves a reservation counting against `outstandingReservations()` with no scheduled wakeup. The user has tokens, was never charged, and gets 402s. Shorten the TTL to minutes for chat-scale jobs and have `reserve()` schedule the reaper. Add a test: reserve, simulate crash, advance past TTL, assert headroom restored.

**59d. 🟢 Prompt caching is an ~80% cut on free-chat input cost.** DeepSeek V4 Flash quotes `input_cache_read` at $0.01876/1M against `prompt` at $0.0938/1M — 5× cheaper. The system prompt and history are re-sent verbatim every turn. Wire OpenRouter cache-control on the stable prefix while the call sites are open anyway. Not urgent, but it is the cheapest line item in this entire document.

**Resolution:** all four findings are now restored in Part VIII §55–§56: unknown models fail closed, the runtime catalog has a verified fallback, logical requests carry stable idempotency keys, reservations have explicit expiries and scheduled alarms, and safe prompt caching is part of the OpenRouter work.

## 60. Two gaps in the debt design itself

**60a. `hardReset()` does not know about `debt_micro_usd`.** `do/wallet.ts` `hardReset()` zeroes `balance`, `free` and `premium` and sets `bonus`. After Part VIII it must also zero or explicitly carry `debt_micro_usd` — otherwise a `[TOKENS-100-GRANT-1]` reset leaves stale sub-cent debt that immediately eats into the fresh grant. The same question applies to account deletion; note `BUG-account-delete-not-cascading.md` already exists in the repo root.

**60b. Debt is unsecured credit with no ceiling.** Part VIII says `settle_ai_cost` should "consume no more than the reservation and available spendable funds." If spendable hits zero mid-accrual, the shortfall stays as debt — and the next top-up is silently consumed by it before the user gets anything. That is a chargeback conversation. Add a `debtCeilingMicroUsd` (declared in `PlatformConfig` + `DEFAULTS` + `numericKeys`): above it, block further metered jobs with a distinct `AI_DEBT_LIMIT` reason, and surface pending debt in the wallet detail sheet as "pending, under 1 token." Users must never discover a balance they did not know they owed.

**Resolution:** Part VIII §52 now defines `debt_micro_usd` as a remainder strictly below one token, clears it on hard reset/account deletion, and records reservation underestimation as platform `unrecovered_micro_usd` rather than hidden user debt. A future top-up is never silently consumed by an accumulated shortfall.

## 61. Owner pricing decision — resolved

Part VIII §52 sets the usage-priced markup to 120. Per Part III §15c that constant reaches **only** `ai_billing.ts`. `FEATURE_COSTS` (`feature_pricing.ts:21-44`) — receptionist minute 3, voicemail 1, image generate 8, listing 100 — are flat hand-set integers with no markup formula, and `feature_pricing.ts:72` holds a separate, dead `AI_MARKUP = 1.30`. After Part VIII lands, those prices still carry whatever margin nobody has computed.

**Decision:** 20% applies to usage-priced AI provider work. `FEATURE_COSTS` remains only for deliberate fixed retail products such as receptionist minutes, voicemail and listings; those are not described as 20%-markup services. The dead duplicate 1.30 usage-pricing path must be removed after call-site verification.

## 62. Document hygiene — resolved

The duplicate Part III and duplicate §15–§21 numbering have been removed. The report now has Parts I–X, sequential §0–§68 numbering, a table of contents, an explicit precedence rule, and `SUPERSEDED` markers on obsolete instructions.

## 63. Amendments integrated into Part VIII §56

Part VIII's order is sound. Three insertions:

| Where | Insert | Why |
|---|---|---|
| **Inside `[AI-WALLET-SPENDABLE-2]`** | Correct the headroom rule per §58 + its double-commit test; clear the remainder in `hardReset()`/account deletion; enforce the `<1 token` remainder invariant and record underestimation as platform loss | §58 prevents cross-policy over-commit; §60 prevents hidden debt or future-top-up seizure |
| **New, before `[AVA-FAST-STREAM-1]`** | `[AI-PRICE-CATALOG-1]` — catalog every model being routed to, in the same commit as the routing; runtime price fetch with the in-code table as fallback | §59a — 100× overcharge, and it scales with request size |
| **Inside `[AVA-FREE-BUDGET-1]`** | Request idempotency key; shorten reservation TTL and schedule the reaper from `reserve()` | §59b, §59c — both produce "I have tokens but it says no," the exact symptom this whole report started from |

Prompt caching (§59d) can ride along with whichever commit touches the OpenRouter call sites.

These insertions are now present in Part VIII §52, §55 and §56; this table remains as review history.

---

*Part IX reviews Part VIII, 2026-07-25. Where Part IX and Part III conflict, Part IX wins. Where Part IX and Part VIII conflict, §58 is the substantive correctness amendment.*

---

# Part X — Final review: one live decision and three integrated amendments

> Review of the integrated Part VIII baseline, 2026-07-25. §58, §59a-d and §60 are confirmed
> integrated into §52/§55/§56 and are correct as written. §65–§67 have now also been
> integrated. **Only §64 remains open: an owner decision with a live cost per day of delay.**

## 64. 🔴 Nobody has decided what production does *while* this is being built

`aiWalletMeteringEnabled` is **`true`** in production right now. `betaFreePremium` is **`false`**. Per §2, that combination means **every user whose tokens are promo/bonus gets a 402 on every AI request**, rendered to them as *"Sorry, I could not find an answer."*

Part VIII is a multi-commit program: typed wallet union, atomic settle, accrual, price catalog, entitlement states, flag contract, budgets, then media jobs. That is days of work minimum. **Every one of those days, AI is dead for every non-paying user, and they are being told the AI does not understand them.**

Part I §2g offered the interim mitigation and it was never chosen. It is now buried under nine parts. Restating it as a decision with a date:

| Option | Effect | Risk |
|---|---|---|
| **A — flip `aiWalletMeteringEnabled=false` now** | `reserveAiJob` reverts to a no-op pass-through; AI works for everyone within ~60s, no build | Attachments/images also become unmetered until the program lands. Given `generativeEnabled` is off and metered multimodal does not exist yet, the actual exposure is close to zero. |
| **B — ship `[AI-WALLET-SPENDABLE-2]` first, keep the flag on** | Correct fix, no intermediate state | Users stay broken until it deploys and verifies |
| **C — leave as is** | — | Users stay broken for the duration of the whole program |

**Recommendation: A.** The flag was flipped on before the code that makes it safe existed (§7, mechanism 1). Turning it back off restores the intended ordering and costs nothing, because the metered multimodal features it protects have not shipped. It is one command and it is reversible.

**This decision should be recorded in this document with who made it and when.** The absence of such a record for the original flip is precisely what §7 identifies as the root process failure.

**Decision record, 2026-07-25:** recommendation A is accepted as the report’s preferred mitigation, but no production flag was changed because the owner has not explicitly authorized the production write in this task. Current status: **pending owner authorization**. If authorized, execute only through `ALLOW_PROD=1 scripts/flags.sh set aiWalletMeteringEnabled=false`, verify with a cache-busted config read, record actor/time/reason, and monitor AI 402s.

## 65. `AI_PRICE_UNKNOWN` availability amendment — integrated

An earlier §52 draft said: *"Refuse to meter or route an unpriced model with `AI_PRICE_UNKNOWN`; never charge users using `AI_DEFAULT_RATE`."*

The billing half is right and closes §59a. **The routing half can reproduce the exact bug this report opens with.** Three failure modes:

1. **Free text chat does not need a price at all.** It short-circuits on `FREE_CAPABILITIES` before any pricing. If the price check runs at *routing* rather than at *metering*, a missing catalog entry blocks a request that was never going to be billed — and the user sees an AI that says nothing. Same symptom, new cause.
2. **Fallback ladders break.** `do/ava_agent.ts` falls through primary → alt → direct-Gemini on 429/5xx. If the alt or the last-resort model is uncatalogued, the ladder terminates and the outage is total instead of degraded.
3. **It re-creates the dependency §59a warned about** — correct billing becomes contingent on a hand-maintained table being complete, forever.

Correct rule:

- **Free capabilities never consult the catalog.** Assert this with a test.
- **Metered capabilities fail closed on *billing*, not on *availability*** — and only when the catalog has no entry **and** the provider reported no `usage.cost`. OpenRouter returns `usage.cost` on the response; when present it is ground truth and no catalog entry is needed. The catalog is the estimator for the *reserve*, not the authority for the *charge*.
- If a metered request completes with neither a catalog price nor a provider cost, **serve the answer, charge nothing, and emit `AI_PRICE_UNKNOWN` as a platform-loss alert.** Never fail a user's request over our own bookkeeping gap.

**Related, and easy to get wrong:** the reserve estimate and the settle must derive from the *same* source. Estimating the reserve from the catalog and settling on provider cost is fine; estimating from a stale catalog entry that is 10× low and then settling higher produces systematic `unrecovered_micro_usd` (see §66). State the pairing explicitly.

**Resolution:** integrated into Part VIII §52 and §55. Free capabilities bypass price and wallet code; unknown-price metered jobs use conservative headroom, provider cost when available, and zero-charge delivery plus alert when neither cost source exists.

## 66. Unrecovered-cost controls — integrated

§52 correctly refuses to carry a shortfall as hidden user debt — that was §60b and the resolution is right. But the money still leaves: *"record the difference as `unrecovered_micro_usd` in the AI billing ledger and platform telemetry."*

Recording is not bounding. As specified, a user holding 1 token can trigger a job whose actual cost exceeds the reserve, and the platform absorbs the difference — repeatably, deliberately, per user. The reserve is a *worst-case estimate*, and §12d already established that for image generation the worst case is **not computable from OpenRouter's payload** (tokens-per-image varies by resolution and provider and is absent from `/api/v1/models`). So the one capability where the reserve is least trustworthy is also the most expensive.

Add:

- `unrecoveredDailyCapMicroUsd` per account (declared in `PlatformConfig` + `DEFAULTS` + `numericKeys`). Once exceeded, metered jobs for that account are blocked with a distinct `AI_UNRECOVERED_LIMIT` reason until UTC rollover.
- A platform-wide daily unrecovered alert threshold. A single miscatalogued model should page someone, not accumulate quietly.
- For image generation specifically: until tokens-per-image is empirically measured per provider, **reserve generously** (a deliberate over-reserve, refunded on settle) rather than under-reserving and eating the gap.

**Resolution:** integrated into Part VIII §52 under “Unrecovered-cost controls,” including per-account blocking, platform alerting, image over-reserve/refund and free-text exemption.

## 67. Headline free-chat and production closure tests — integrated

The §52 test list is thorough on money mechanics and omits the two things the owner actually asked for.

**67a. Free text chat must touch the wallet zero times.** No reserve, no settle, no `wallet_transactions` row, no `resv` row, no `debt_micro_usd` movement — for both `chat_ava` (Ask Ava) and `chat_thread` (`#ava`/`@ava`), and **with `aiWalletMeteringEnabled = true`**, since that is the whole point of the `FREE_CAPABILITIES` short-circuit surviving a flag flip. This is the single most important behavioural guarantee of the change and it is not in the required cases.

**67b. There is no production verification step tied to the original report.** Every acceptance criterion in Part VIII is a unit test. Unit tests would have passed throughout the current outage. The criterion that actually closes this report is observable, specific, and already instrumented:

> On build > 10462, `hdavy2002@gmail.com` opens Ask Ava, sends "hi", and receives a real reply.
> PostHog shows `ava_chat_request` with **no** following `api_error status=402`, and
> `wallet_transactions` shows **no** new row for that turn.

Add the same check for a bonus-only *staging* account before prod. §7 mechanism 5 — no build number in bug reports — applies to verification too: record the build the check was run on.

**Resolution:** the zero-wallet free-chat test is now required in Part VIII §52, and the staging/production PostHog closure procedure is now explicit in Part VIII §55–§56.

## 68. Confirmed correct, no further comment

§58 headroom rule (all outstanding reservations subtracted from both, asymmetric formula deferred behind property tests), the `0 <= debt_micro_usd < 10,000` remainder invariant, `hardReset()` and account-deletion clearing, reservation `expires_at` with scheduled alarms, stable idempotency keys across retries, prompt caching, the fixed-retail-price decision for receptionist/voicemail/listings (§61), and the renumbering to a single Part III with a table of contents (§62) — all reviewed against source, all correct as written.

---

*Part X reviews the integrated Part VIII baseline, 2026-07-25. §64 was the correct interim decision before the billing wave deployed; Part XI now supersedes its live-incident status. §65-§67 remain amendments to Part VIII §52 and §55.*

---

# Part XI — Post-ship reconciliation and remaining permanent fixes

> Source/live-state reconciliation after the production Worker, consumer and billing migrations
> described by the implementing agent. This is an audit and report update, not another deploy.
> No production flag, Worker, database or build was changed by this pass.

## 69. What is actually shipped, and what is not

The central billing correction is present in `main` and matches the hard parts of Parts VIII–X:

- `worker/src/routes/wallet.ts` has the typed wallet-operation union and runtime validation.
- `worker/src/do/wallet.ts` admits AI reservations against spendable funds and settles atomically
  from free → bonus → paid while keeping `0 <= debt_micro_usd < 10,000`.
- `worker/src/lib/ai_billing.ts` short-circuits `chat_ava` and `chat_thread` before config,
  catalog or WalletDO access; usage-priced settlement applies `AI_MARKUP_BPS = 120`.
- `worker/src/routes/ava_gemini.ts` and `worker/src/do/ava_agent.ts` both select
  `deepseek/deepseek-v4-flash` for ordinary free text.
- Production effective config was read on 2026-07-25 and confirms
  `aiWalletMeteringEnabled=true`, `betaFreePremium=false`,
  `freeTextMaxInputTokens=32,000`, `freeTextDailyInputTokens=2,000,000`,
  `freeTextDailyOutputTokens=200,000`, `freeTextDailyCostMicroUsd=50,000`,
  `unrecoveredDailyCapMicroUsd=50,000`, and
  `unrecoveredPlatformAlertMicroUsd=1,000,000`.

The owner-facing status needs four qualifications:

| Claim | Correct status |
|---|---|
| “Ask Ava works in the existing app now” | **Expected from the server fix, but not yet proven by the named production smoke.** Build 10462 calls the repaired Worker. |
| “Messenger `#ava`/`@ava` works in the existing app now” | **False for free users on build 10462.** The old binary contains the local `_premium` gate. Commit `5b794c0` removes it, so this surface needs the approval-gated mobile build. |
| “The AvaBrain sessions/archive/new-chat UI is done” | **Implemented in source, not yet live on the investigated device.** `companion_home.dart`, `companion_session_store.dart`, `companion_thread.dart` and `ava_chat_history.ts` provide session cards, New chat, open, rename, star, archive/unarchive, delete and cloud/local persistence. It still needs build/device verification. |
| “Wave 3 media UX shipped” | **Correctly not shipped.** Only the safe job/state backbone is on `main`; the provider handlers and chat wiring remain parked. |

`latestAppBuild` is still **10462** in production. The newer run being paused at the
production approval gate therefore matters: server-only fixes can be live, but client paywall,
session-shell, entitlement and media-card changes cannot be called live until that build is
approved, installed and smoke-tested.

## 70. 🔴 Ask Ava is still the slow, non-streaming experience

Changing the model improves provider latency but does not fix the owner’s main UX complaint.
`app/lib/features/askava/askava_screen.dart:155` still calls
`AvaAiClient.I.ask(...)`, waits for the whole response, and renders only
`“Ava is thinking…”` meanwhile. The streaming client and endpoint already exist:

- `app/lib/core/ava_ai_client.dart` → `askStream()`
- `worker/src/routes/ava_gemini.ts` → `avaGeminiStream()`

`app/lib/features/ava_companion/companion_thread.dart` already consumes that stream, but Ask
Ava does not. Therefore the shipped summary does **not** close Part V for Ask Ava.

**Exact fix:**

1. Edit `app/lib/features/askava/askava_screen.dart`.
   Insert an empty assistant bubble immediately, consume `askStream()` deltas into that same
   bubble, let the composer re-enable after first token, and keep the one-shot `ask()` only as
   a fallback when the stream fails before any delta.
2. Preserve the current local tool protocol without flashing raw JSON. Buffer a response that
   begins like a tool object; once the object is complete, execute the local tool and start the
   next hop. Stream ordinary prose immediately.
3. Edit `app/lib/core/ava_ai_client.dart` so `askStream()` carries `source`,
   surfaces structured `blocked/reason` SSE fields, and reports HTTP error bodies rather than
   reducing every non-200 to `stream http N`.
4. Edit `worker/src/routes/ava_gemini.ts` streaming handler to emit
   `ava_chat_request`, `ava_chat_first_token`, `ava_chat_completed` and `ai_error`, with
   `request_id`, `model`, `setup_ms`, `ttfb_ms`, `provider_ms`, `total_ms`,
   `stream_chars`, fallback reason and provider status.
5. Add Worker tests for first-token timing/error events and a Flutter test proving that later
   user messages do not replace or move the in-progress assistant bubble.

**Acceptance:** p50 TTFT <1.5s and p95 TTFT <3s on a warm connection; no indefinite
“thinking” card; cancellation and navigation release the HTTP client; a tool-call hop never
shows JSON to the user.

## 71. 🔴 The “hard” daily cost controls are raceable and can be bypassed

The free-text and unrecovered-cost budgets are stored in KV using read → add → put:

- `worker/src/lib/ai_gate.ts`:
  `free_text_budget:<uid>:<day>`
- `worker/src/lib/ai_billing.ts`:
  `ai_unrecovered:<uid>:<day>` and `ai_unrecovered:platform:<day>`
- `worker/src/lib/ai_quota.ts`:
  `ava_turns:<uid>:<day>`

These are not atomic. Many simultaneous requests can all read the same old value, all pass the
pre-flight, and overwrite one another with the same increment. The comment in
`ai_billing.ts` saying a concurrent double count errs in the platform’s favour is backwards:
lost updates **undercount** usage and delay/block neither the account cap nor the platform
alert. A scripted account can therefore exceed the stated hard spend bound.

**Permanent fix:**

1. Add an atomic per-account daily-budget operation to the existing WalletDO (preferred because
   every account already maps to one serialized authority), or a dedicated per-account
   `AiBudgetDO`. Do not use D1/KV check-then-write.
2. The operation must atomically reserve estimated free-lane input/output/cost before the
   provider call, then settle actual usage/refund unused estimate afterward. Include the UTC
   day in the row/key and make both operations idempotent on request ID.
3. Keep the platform-wide aggregate in a single sharded/serialized authority or derive it from
   the durable `ai_billing_ledger`; KV may be a dashboard cache, never the enforcement source.
4. Change `worker/src/lib/ai_gate.ts`, `worker/src/lib/ai_quota.ts` and
   `worker/src/lib/ai_billing.ts` to call that authority. Add a 50-way concurrency test in
   `worker/test/` proving admitted cost never exceeds the configured ceiling by more than one
   already-reserved request.
5. Fail policy must be explicit: free text may degrade to a small emergency allowance during
   the authority outage; metered expensive jobs fail closed with a truthful temporary message.

Until this lands, describe these values as **best-effort budgets**, not hard anti-abuse caps.

## 72. 🔴 The original production incident still lacks closure evidence

The code and live flags make the server fix credible, but the report must not convert
“deployed” into “verified.” The PostHog connector was unavailable in this reconciliation, and
no new event for `hdavy2002@gmail.com` was inspected.

Required closure record:

1. On current build 10462, `hdavy2002@gmail.com` sends `hi` in **Ask Ava**.
2. Record visible reply, UTC timestamp, app/build, request ID and total/TTFT latency.
3. Confirm PostHog has the request and completion (or streaming equivalents), with no following
   `api_error`/`ai_error` 402.
4. Confirm wallet snapshot, `wallet_transactions`, reservations and
   `debt_micro_usd` are unchanged for that `chat_ava` request.
5. After approving/installing the newer build, repeat for private `@ava` and shared `#ava`.
   Build 10462 is not a valid closure device for the client-paywall removal.
6. Keep `aiWalletMeteringEnabled=true` during these tests. Turning it off would hide a
   regression in the structural free-capability contract.

Only after all three text surfaces pass should Part I’s live incident be marked closed.

## 73. 🟠 The report’s moderation assurance is false in current source

Parts III/VIII reasoned that DeepSeek being unmoderated at the provider was acceptable because
`guardInput/isSafe` wrap every turn. In `worker/src/lib/ai_gate.ts`, however, `isSafe()` is an
intentional unconditional `true` no-op under the 2026-06-24 owner decision to remove AI-chat
moderation. `runGated()` keeps the old function names but performs no classification.
`avaGeminiStream()` bypasses `runGated()` as well.

This is not silently reclassified here as a bug against an owner decision. It is a **policy
decision that the report currently describes inaccurately**. Resolve it explicitly:

- If unmoderated chat remains the owner’s decision, change comments, tests, cost assumptions and
  product/safety documentation to say that plainly. Do not claim Llama Guard coverage.
- If moderation is restored, implement one consistent policy for non-streaming Ask Ava,
  streaming AvaBrain, and Messenger `@ava/#ava`; add age/context handling and measure its TTFT
  cost before rollout.

There is also a billing-budget error today: `runGated()` charges the internal free-chat budget
for synthetic “guard calls” even though `isSafe()` makes no model call. This makes users hit the
daily cost cap earlier and makes platform-cost telemetry overstate reality. Edit
`worker/src/lib/ai_gate.ts` so only real provider calls contribute cost; provider-reported usage
should replace token estimates where available.

## 74. 🟠 The media-job API is live but every provider handler is a stub

The safe backbone on `main` is useful: authenticated owner-scoped rows, durable state,
idempotent claim/complete/fail, reservation release and client repository/card components.
However:

- `worker/src/queues/ai_media.ts` maps all five kinds to `notImplemented`.
- `worker/src/routes/ai_media_jobs.ts` gates create only on broad `aiEnabled`; it has no
  media-job rollout flag.
- The routes are registered in `worker/src/index.ts`, so an authenticated caller can create a
  job, reserve tokens, and receive `NOT_IMPLEMENTED` after the inline fallback runs.
- `Q_AI_MEDIA` is not yet a declared production binding; `ctx.waitUntil()` is only a temporary
  fallback and is not sufficient for long image/document/audio work.

No user should encounter a paid-looking action that is guaranteed to fail. Before wiring any
client menu:

1. Add `aiMediaJobsEnabled` to `PlatformConfig`, `DEFAULTS`, `numericKeys` and the flag-contract
   test, default **false**.
2. Gate `POST /api/ai/jobs` on that flag with a distinct `AI_MEDIA_NOT_LIVE` response. Reads and
   cancellation may remain available for recovery of already-created jobs.
3. Declare `Q_AI_MEDIA` in `worker/wrangler.toml`/environment types and deploy it before any
   handler is enabled.
4. Add per-kind readiness flags, or a server-side `SUPPORTED_KINDS` set, so one finished handler
   cannot accidentally expose the other four.
5. Never merge parked commit `8a81053` wholesale. Rebuild its UX on the safe backbone only after
   all seven blockers in that commit message are closed and independently re-gated.

## 75. Metered 20% pricing exists, but the requested media products do not use it yet

The statement “micro-USD accrual exists but nothing metered is routed through it” is now too
broad. Current source routes these through `reserveAiJob/settleAiJob`: Ask Ava image turns,
AI util calls, `@ava` tool work, and the media-job backbone. The ordinary text capabilities
short-circuit free as intended.

But the owner-requested production media actions still use legacy routes or are disabled:

- `worker/src/routes/ava_image.ts`
- `worker/src/routes/ava_copilot.ts`
- `worker/src/routes/stt.ts`
- Wave 3 job handlers in `worker/src/queues/ai_media.ts`

Production confirms `generativeEnabled=false`, `avaDocActionsEnabled=false`,
`fileAnalysisEnabled=false`, `translationEnabled=false` and
`avaAutoTranslateFileEnabled=false`. Therefore “20% everywhere” is implemented in the billing
authority, not delivered as an end-to-end media product.

One catalog gap also remains: `MODEL_BY_KIND.audio_*` names
`openai/whisper-large-v3`, but `AI_PRICE_CATALOG` has no matching row. The conservative
`AI_DEFAULT_RATE` is acceptable only for reserve headroom; settlement must receive a real
provider cost or the job is delivered free with `AI_PRICE_UNKNOWN`. Before audio goes live,
pin the actual STT/TTS/translation provider IDs, verify their prices, add them to the catalog,
and prove provider cost reaches settlement.

## 76. AvaBrain session UX is present; “the brain knows everything” is not yet proven

The requested session-management UI is no longer missing in source:

- `app/lib/features/ava_companion/companion_home.dart` — old sessions, New chat, Archived view,
  card menus and reorder.
- `app/lib/features/ava_companion/companion_session_store.dart` — per-account local-first
  SQLite plus cloud metadata sync.
- `worker/src/routes/ava_chat_history.ts` — owner-scoped list/open/archive/delete/reorder.
- `app/lib/features/ava_companion/companion_thread.dart` — streaming thread and persistence.

Do not confuse this UI with proof of whole-life memory. The asset/index wave creates
`brain_assets` and consent-aware derivatives, but permanent acceptance still requires:

1. Upload a private image, PDF and audio item; verify each produces an owner-scoped asset and
   searchable derivative without a public R2 object.
2. Query AvaBrain by natural description and verify the result resolves to the exact
   `media_id`, conversation and safe title, with a tappable source.
3. Revoke a domain and prove query-time filtering removes the hit immediately; delete the
   source and prove derivatives disappear.
4. Confirm received DM media can be indexed only through the authorized account-private
   plaintext lane; never identify it by ciphertext hash.
5. Verify sessions/archive/new-chat on two accounts sharing one device and on a second device.
6. Record recall latency, result count, source IDs and explicit `recall_empty`,
   `consent_blocked`, `index_pending` or `unsupported_visual_indexing` outcomes in PostHog.

The current live value `brainEnabled=false` is a legacy flag with no remaining app consumer;
it is not evidence by itself that the new AvaBrain is disabled. It should be removed or renamed
so a future operator does not use another misleading/fake flag to diagnose the product.

## 77. Correct next order

1. **Close production text empirically** (§72); do not change metering to make the test pass.
2. **Approve/install the mobile build when the owner chooses**, then verify Messenger paywall
   removal and AvaBrain session UI. This report does not authorize or trigger that build.
3. **Stream Ask Ava and add TTFT telemetry** (§70).
4. **Make budgets atomic** (§71), before treating the 200-turn/free-cost limits as abuse
   protection.
5. **Resolve and document moderation policy** and remove synthetic guard cost (§73).
6. **Dark-gate the stub media API and add the real queue** (§74).
7. Implement one provider handler at a time: image → document → transcription → translated
   audio. For each: private artifact storage, correct `media_id`, actual provider cost,
   20% micro-USD settlement, durable placeholder UX, full-screen/download action and
   production telemetry. Never enable all five in one flag flip.
8. Run the AvaBrain retrieval/privacy matrix (§76) before claiming that AvaBrain knows the
   user’s past, present and future.

**Permanent process rule:** every completion statement must name which layer is live:
source, deployed Worker, effective production flag, approved mobile build, installed device,
and verified user event. “Shipped” without those six qualifiers is how a server fix, a parked
client and an unverified UX become one misleading sentence.

---

*Part XI reconciles `main` at `336e1b0` and the production effective config read on
2026-07-25. It supersedes only stale live-status claims; the historical root-cause evidence
and accepted billing invariants remain valid.*

# Part XII — Missing-findings remediation implemented in source

## 78. Scope and live-status boundary

This part records the source remediation for §70–§76. It does **not** claim a production
deployment, an approved Android build, an installed-device result or a PostHog production
smoke. No production flag, queue, Worker, database or mobile build was changed while writing
this section.

| Finding | Source result | Still required before “live” |
|---|---|---|
| Ask Ava waits for a complete response | Converted to SSE delta rendering; internal JSON tool calls are buffered and hidden | CI, mobile build approval/install, device TTFT test |
| Build 10462 Messenger paywall | Source removal was already present in `chat_thread.dart` | Approval-gated mobile build and installed-device test |
| Raceable free-chat cap | Replaced by atomic per-account reserve/settle/release in WalletDO | CI + staging concurrency test + deployment |
| Raceable unrecovered-cost cap | Replaced by atomic maximum-loss exposure reservation, then actual-loss settle/release | CI + staging billing fault tests + deployment |
| `isSafe()` always true | Real Workers AI Llama Guard classification restored | Safety/product approval and measured latency/false-positive rollout |
| Imaginary moderation cost | Budget counts a guard only when the provider call actually ran | CI and production cost telemetry |
| Five live stub handlers | Create API dark-gated globally and by implemented-kind set; all five stubs remain unsupported | Provision queues, implement one handler, then enable that kind |
| Whisper missing price | Added verified `$0.0015/minute` (`25 micro-USD/second`) catalog row | Re-verify on activation and prefer provider-reported cost |
| AvaBrain session UI unverified | Source reconfirmed; no new implementation was needed | Build/install plus two-account/two-device acceptance |
| Original 402 closure evidence | Correlation IDs and streaming request/TTFT/completion/error events added | Named production smoke and PostHog/wallet evidence |

## 79. Ask Ava streaming and latency files

Changed:

- `app/lib/features/askava/askava_screen.dart`
  - consumes `AvaAiClient.askStream()` instead of waiting on `ask()`;
  - creates and updates one assistant turn as deltas arrive;
  - keeps a possible JSON tool response hidden until complete;
  - preserves the existing three-hop local tool protocol and persists only the visible result.
- `app/lib/core/ava_ai_client.dart`
  - sends `source` and a stable UUIDv7 `request_id`;
  - propagates the same ID as `X-Trace-Id`;
  - preserves bounded server error detail for non-200 stream responses.
- `worker/src/routes/ava_gemini.ts`
  - accepts the stable client request ID and uses it for budget/billing idempotency;
  - applies real input safety classification before opening a model stream;
  - emits `ava_chat_request`, `ava_chat_first_token`, `ava_chat_completed` or `ai_error`
    with request ID, source, model, setup, TTFT, provider and total timing;
  - settles actual streamed usage or releases unused reservations.

The buffered `runGated()` path performs input and output classification. The live-token SSE
path performs input classification before streaming; it does not falsely claim that a
post-generation output classifier can retract tokens already shown. If output moderation is
required for that lane, implement a sentence/chunk buffer or gateway streaming guard as a
separate measured change because it directly affects TTFT.

## 80. Atomic budget authority

Changed:

- `worker/src/do/wallet.ts`
- `worker/src/routes/wallet.ts`
- `worker/src/lib/ai_gate.ts`
- `worker/src/lib/ai_billing.ts`
- `worker/src/routes/ava_gemini.ts`
- `worker/src/do/ava_agent.ts`

WalletDO now owns two non-financial serialized ledgers:

1. `ai_daily_budget`: request-ID keyed free-chat reservations with reserved versus actual
   input/output/cost and released/settled terminal states.
2. `ai_unrecovered_budget`: request-ID keyed maximum platform-loss exposure with
   reserve/settle/release states.

This matters because a simple atomic “amount lost so far” counter was still insufficient:
concurrent jobs could all pass before the first one recorded a loss. Metered jobs now reserve
their maximum exposure before provider work. Wallet failure releases that exposure; successful
settlement replaces it with real unrecovered cost; provider failure releases it.

The platform-wide unrecovered value is derived from the durable `ai_billing_ledger`. KV is
used only to suppress duplicate alert notifications and is no longer an admission authority.
Free text still performs zero token-balance, financial-reservation, debt or transaction
mutations; its budget rows are cost-control metadata in the same per-account serialized DO.

## 81. Moderation and budget accounting

`worker/src/lib/ai_gate.ts` once again calls
`@cf/meta/llama-guard-3-8b`. A confident unsafe verdict blocks; a classifier outage fails open
so a moderation outage cannot reproduce the “Ava says nothing” incident.

The budget tally uses the classifier result’s `providerCalled` field. Empty input and failed
classifier calls add zero synthetic guard cost. Real input/output checks and a real regenerate
pass are counted. Messenger’s simple `@ava/#ava` lane now performs the same real input and
buffered-output checks.

## 82. Media API containment and real queue contract

Changed:

- `worker/src/routes/config.ts`: added boolean `aiMediaJobsEnabled`, default false.
- `worker/src/routes/ai_media_jobs.ts`: create fails with `AI_MEDIA_NOT_LIVE` while dark and
  `AI_MEDIA_KIND_NOT_LIVE` for any stubbed kind before a job or token reservation is created.
- `worker/src/queues/ai_media.ts`: added an explicit implemented-kind set (currently empty),
  removed the long-running `waitUntil()` fallback, and terminally fails repeated timeouts.
- `worker/src/types.ts`, `worker/wrangler.toml`, `worker/src/index.ts`: declared the real
  producer/self-consumer queue in production and staging.

The queue names must be provisioned before deploying this configuration:
`ai-media-jobs` and `ai-media-jobs-staging`. Creating those queues is an environment write and
was intentionally not done without a separate production/staging confirmation. Keeping the
feature flag false is not a substitute for provisioning a binding required at deploy time.

No stub handler is presented as supported. Add a kind to `IMPLEMENTED_KINDS` only in the same
commit that replaces its `notImplemented` handler and passes its privacy, billing, artifact
and recovery tests.

## 83. Pricing and regression coverage

`worker/src/lib/ai_billing.ts` now catalogs `openai/whisper-large-v3` at OpenRouter’s verified
price of `$0.0015/audio minute`, represented as `25` integer micro-USD per second. The source
is recorded beside the rate.

Tests changed/added:

- `worker/test/ai_free_budget.test.ts`: 50-way concurrent admission, idempotent request IDs,
  real versus failed moderation-call accounting, unsafe-input blocking, and zero financial
  wallet metering for both free text capabilities.
- `worker/test/ai_billing.test.ts`: Whisper duration-price regression.
- `worker/test/ai_media_rollout.test.ts`: all five stub kinds remain dark.

Per repository policy these tests were authored but not run locally. CI is the verification
authority.

## 84. Required closure sequence

1. Review and commit the source changes by issue, then run CI.
2. Provision `ai-media-jobs-staging`; deploy to staging with `aiMediaJobsEnabled=false`.
3. Run concurrency, moderation, streaming cancellation/error and billing fault tests in
   staging.
4. Approve a mobile build only when the owner explicitly chooses environment and APK/AAB.
5. On the installed build, verify Ask Ava streams and AvaBrain New chat/open/archive/delete
   on two accounts sharing one device.
6. Repeat the named `hdavy2002@gmail.com` smoke with
   `aiWalletMeteringEnabled=true`: Ask Ava, private `@ava`, shared `#ava`.
7. In PostHog, join by `request_id`/`trace_id` and record request, first-token, completion,
   no 402, model, build and latency.
8. Prove wallet balance, free/bonus/paid buckets, debt, financial reservations and
   transactions are unchanged for each free-text request.

Until steps 1–8 pass, use the status **implemented in source, not production-verified**.
