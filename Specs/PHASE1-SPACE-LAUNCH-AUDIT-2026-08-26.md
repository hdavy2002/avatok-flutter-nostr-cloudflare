# Phase 1 "Space" — launch audit and minimum path to live

> 🔻 **PARTIALLY SUPERSEDED 2026-08-27 by `Specs/PIVOT-2026-08-27-MARKETPLACE-FIRST-PAID-SESSIONS.md`.**
> The audit findings below (what exists, the four gaps, the effort estimates) remain accurate
> and were re-verified. What CHANGED the day after this was written: Messenger audio/video
> calling is being **killed** rather than kept alongside; the app's default landing screen
> becomes **Marketplace**; AI in chat goes **dark**; payments move to the **web only**; and
> the GetStream region is **Mumbai**. Read the pivot spec first — it is the governing
> document. Section 5 "Decisions you need to make" has been answered there.

**Date:** 2026-08-26 · **Environment audited:** production (read-only) · **No writes made**
**Scope:** creator live-streaming events + paid 1:1 consultation, with browser fallback for emailed links
**Media provider (owner decision, this session):** GetStream
**Browser fallback (owner decision, this session):** minimal web pages on Cloudflare

---

## 0. The one-line answer

**You do not need to build this. It is already built.** The whole product you described —
creator creates a live event, sells tickets, broadcasts from his phone, buyers get a link,
plus paid 1:1 consultation — was specified, implemented and staging-verified between
2026-08-24 and 2026-08-25 as **Phase 2** (`Specs/SPEC-2026-08-24-PHASE-2-GETSTREAM-LIVE-CONSULT-MARKETPLACE.md`,
812 lines, §15 status). It runs on **GetStream**, exactly as you chose. Every flag is off in
production right now.

**Zero new Flutter screens are required.** The remaining work is: (a) GetStream account
configuration, (b) one new browser viewer, (c) the ticket email, (d) three known web-side
holes. Estimate below: **~2 weeks of build, then a staged flag ladder.**

There is no feature called "Space" anywhere in the repo. Treat "Phase 1: Space" as the
product name for what the code calls the **commercial lane**.

---

## 1. What already exists (verified in code, not from notes)

### 1.1 Backend — complete

| Piece | Where | State |
|---|---|---|
| GetStream commercial session authority | `worker/src/routes/commercial_stream_sessions.ts` (1672 lines) | built |
| Server-minted call ids / types | `worker/src/lib/commercial_stream_sessions.ts:8-55` — `avatok_livestream` = `live_<listingId>_<v>`, `avatok_consult_1to1` = `consult_<bookingId>` | built |
| HLS start on go-live | `commercial_stream_sessions.ts:958-960` — `{ start_hls: true }` | built |
| Routes | `worker/src/index.ts:1386-1434` — `/api/commercial/(live\|consult)/:id/{checkout,join,prepare-host,go-live,end,state}` | built |
| Signed webhook ingestion (attendance = money truth) | `stream_video_calls.ts:1820-1843`, `commercial_stream_sessions.ts:1263` | built |
| Escrow, 80/20 split, settlement, refunds, receipts | `worker/migrations/2026-08-24-commercial-stream-sessions.sql` + 3 more | migrations applied to **staging only** |
| Token minting (secret never leaves server) | `stream_video_calls.ts:505-533` | built |

### 1.2 Flutter app — complete, no new UI needed

`app/lib/features/commercial_getstream/` — `commercial_live_screens.dart`,
`commercial_consult_screens.dart`, `commercial_getstream_handoff.dart` (host joins with
`hintHighScaleLivestreamPublisher: true`, `:298-303`).
Plus `marketplace/commercial_service_cards.dart`, `listings/share_live_event_sheet.dart`
(Copy / Share / WhatsApp / Email), `booking/commercial_customer_screens.dart`.

**Answer to "how does the creator livestream from his phone?"** — He already can. Creator
Studio → create live event → readiness → backstage → Go Live. The phone publishes straight
into GetStream as a high-scale livestream publisher. No RTMP, no OBS, no extra app.

### 1.3 Production flag state (read cache-busted from `api.avatok.ai/api/config`, 2026-08-26)

```
commercialLiveListingsEnabled   = false      commercialConsultListingsEnabled = false
commercialLiveCheckoutEnabled   = false      commercialConsultCheckoutEnabled = false
commercialLiveJoinEnabled       = false      commercialConsultJoinEnabled     = false
commercialCreatorFeePct = 80    commercialSettlementHoldHours = 24
streamCallsEnabled = true   <-- GetStream is ALREADY live in prod for Messenger 1:1 calls
```

The account, the SDK, the push wiring and the token route are all proven in production
today. Phase 2 is a second call type on the same account, not a new vendor.

---

## 2. The four real gaps

### Gap A — the browser viewer is on the wrong provider (the only significant build)

The web app (`web/`, Astro 5 on Cloudflare Pages project `avatok-app`) **already has the
pages you asked for**:

- `web/src/pages/watch/[id].astro` → live viewer
- `web/src/pages/e/[event].astro` → public event landing page (SSR, share-friendly, countdown, add-to-calendar)
- `web/src/pages/consult/[booking].astro` → 1:1 room
- `web/src/pages/l/[id].astro` → listing page (the URL `ShareLiveEventSheet` mints)

But their players are **Cloudflare**, not GetStream:
`web/src/islands/live/WhepPlayer.ts` + `HlsFallback.ts` (Cloudflare Stream Live WHIP/WHEP),
and `web/src/islands/consult/SfuClient.ts` (raw `RTCPeerConnection` against Cloudflare
Realtime SFU).

The spec names this itself at line 88: *"add a responsive AvaTOK web event landing page and
GetStream web viewer."* It is the one piece Phase 2 deliberately deferred.

**Work:** swap the island internals, keep the pages and the design.
`LiveViewer.tsx` calls `POST /api/commercial/live/:id/join`, gets `{api_key, token, call_id,
call_type}`, and renders with `@stream-io/video-react-sdk` (or plain HLS from GetStream's
HLS URL for pure watchers — cheaper and works on every browser including iOS Safari).
`ConsultRoom.tsx` does the same against `/api/commercial/consult/:id/join`.
Entitlement is already checked server-side; the link stays a discovery link, never a ticket.

> Recommendation: for **live viewing**, use GetStream **HLS playback** in the browser, not
> WebRTC. Latency goes from ~500ms to ~10s, but it plays everywhere with `hls.js`
> (already a dependency, `web/package.json`), costs less, and needs no SDK. Use the
> WebRTC SDK only for the 1:1 consult room, where two-way is required.

### Gap B — emailed links land on a 404

`/j/`, `/a/`, `/i/`, `/g/` are declared as verified Android App Links
(`app/android/app/src/main/AndroidManifest.xml:206-244`) and **every calendar email CTA mints
`https://avatok.ai/j/<token>`** (`worker/src/cal/ics.ts:39`, `worker/src/cal/emails.ts:37-41`).
There is **no `/j/` page in `web/src/pages/`.** The only handler lives in
`marketing/public/_worker.js:123-129`, which belongs to the *other* Pages project.
`app/lib/core/deep_links.dart` has no `/j/` handler either — the link opens the app and does
nothing.

Also: only `web/src/pages/add.astro` implements the "open the app, else fall back" pattern
(`:51`, `:7`). `l/[id].astro` has no such fallback.

**Work:** one shared smart-link component; add `/j/` to `web/` and to `deep_links.dart`;
point commercial emails at `https://avatok.ai/l/<listing_id>` (stable, entitlement-checked)
rather than a `/j/` token.

### Gap C — web checkout charges USD, everything else is ₹

`web/src/islands/checkout/PayStep.tsx` calls `POST /api/wallet/topup` with `amountUsdCents`
and prints `$`. `worker/src/routes/wallet.ts` hard-writes `currency:'usd'` on that legacy
route. The INR route `POST /api/wallet/topup/intent` already exists and the Flutter app uses
it. Backend emails already print ₹ (`worker/src/cal/emails.ts:9`).

This blocks your whole flow: the email recipient who does not have the app **pays on the
web**. Today he'd be quoted dollars and then receive a rupee receipt.
(Documented as Gap 2 in `WEB-PLATFORM-AUDIT-2026-08-25.md:86-106`.)

### Gap D — no live-event ticket email exists

Brevo is wired (Worker → `Q_EMAIL` queue → `consumers` Worker → Brevo REST,
`consumers/src/index.ts:349-367`), templates are hand-written HTML in
`worker/src/cal/emails.ts`, and there are six of them: booking confirmed, booking cancelled,
refund, settlement, payout, reminder (24h / 60m).

**None is a live-event ticket.** You need two new ones on the same `shell()` wrapper —
*Ticket confirmed* and *Starting soon* — both linking to `https://avatok.ai/l/<listing_id>`.
That is a ~50-line addition, not a new system.

---

## 3. What the emailed link should do (the flow you described)

One URL for every channel: **`https://avatok.ai/l/<listing_id>`**

| Where it's opened | What happens |
|---|---|
| Phone, AvaTOK installed | Android App Link fires → `deep_links.dart:143-151` → listing/session screen → Join |
| Phone, no app | `l/[id].astro` renders the event page; **Watch in browser** (GetStream HLS) + a secondary Install AvaTOK button |
| Desktop | Same page, same browser player |
| Forwarded to someone else | Page loads, shows **Buy ticket** — entitlement is bound to the signed-in account, not the URL (`spec:71-86`) |

Never put a GetStream token, order id or call id in the email. The spec is explicit at
line 84 and the server already enforces it.

---

## 4. Minimum path to launch

Nothing here touches the Flutter UI. Ordered so each step is independently reversible.

| # | Work | Where | Effort |
|---|---|---|---|
| 1 | Create call types `avatok_livestream` + `avatok_consult_1to1` in the GetStream dashboard; set host/viewer role permissions; register the signed webhook | GetStream console | 0.5 day |
| 2 | Set `STREAM_VIDEO_API_KEY` / `STREAM_VIDEO_API_SECRET` as Worker secrets on **staging** (absent from both `wrangler.toml` blocks by design) | `wrangler secret put` | 1 hour |
| 3 | Apply the 4 commercial migrations to **prod** D1 (staging-only today) | deliberate prod step | 1 hour |
| 4 | **INR checkout on web** — repoint `PayStep.tsx` at `/api/wallet/topup/intent`, format ₹ | `web/src/islands/checkout/` | 1–2 days |
| 5 | **GetStream web viewer** — rewrite `LiveViewer.tsx` internals for GetStream HLS; `ConsultRoom.tsx` for GetStream WebRTC | `web/src/islands/live/`, `.../consult/` | 4–6 days |
| 6 | **Smart link + `/j/` page** — shared open-in-app-else-web component, add to `l/[id]`, `watch/[id]`, `e/[event]`; add `/j/` route and Dart handler | `web/src/pages/`, `app/lib/core/deep_links.dart` | 1 day |
| 7 | **Two ticket emails** — confirmed + starting-soon, ₹, linking `/l/<id>` | `worker/src/cal/emails.ts` | 1 day |
| 8 | Seed 2–3 real creator listings; two physical accounts; run §11 device scenarios on staging | staging | 2 days |
| 9 | Flag ladder in prod, one flip at a time | `ALLOW_PROD=1 scripts/flags.sh` | staged |

**Build total: ~10–13 working days.** Steps 1–3 are configuration; 4–7 are the only code.

### Flag ladder (step 9) — the order the spec mandates (§744)

```
listings  →  checkout  →  join  →  consult before live
commercialConsultListingsEnabled=true
commercialLiveListingsEnabled=true
commercialConsultCheckoutEnabled=true
commercialLiveCheckoutEnabled=true
commercialConsultJoinEnabled=true
commercialLiveJoinEnabled=true
```

Leave `commercialConsultExtensionEnabled`, `commercialRecordingEnabled`,
`commercialReplayEnabled` off at launch.

---

## 5. Decisions you need to make

1. **Web live playback: HLS or WebRTC?** HLS is my recommendation — ~10s delay, works on
   every browser, cheaper, no SDK. WebRTC is sub-second but heavier and fussier on iOS
   Safari. For a paid talk or class, 10s is invisible.
2. **Do we retire the old Cloudflare AvaLive path?** `worker/src/routes/live.ts` +
   `app/lib/features/avalive/` are a complete second live stack on Cloudflare Stream Live
   (WHIP/WHEP), `liveEnabled=false` in prod. Two live stacks is a maintenance tax. Phase 2E
   says "replace"; the code hasn't been deleted. Suggest: leave dark, delete after Phase 1
   ships clean.
3. **Consultation extensions at launch?** `commercialConsultExtensionMinutes` and
   `...Rate` are both `0` — the feature is built but unpriced.
4. **iOS.** There is no `app/ios/` directory, no AASA file, no Associated Domains. On iPhone
   every link falls to the browser. That is fine for Phase 1 — but it means the web viewer
   (step 5) is the *only* iOS experience, which raises its priority.

---

## 6. Conflict to be aware of

`CLAUDE.md` and `Specs/AVATALK-CLOUDFLARE-RULEBOOK.md` state Cloudflare is the sole
real-time media provider. The Phase 2 spec deliberately overrides that **for the commercial
lane only** (`spec:12-19`: "Cloudflare must not carry Phase 2 media"), and prod already runs
`streamCallsEnabled=true` for Messenger 1:1. The rulebook text should be amended to say so
explicitly, or the next agent will "fix" this back to Cloudflare.

---

## 7. Method

Graphify (`graphify-avatok-2-flutter`), Graphiti (`group_id=proj_avaflutterapp`), three
parallel read-only code sweeps, and a cache-busted read of live production config. Every
claim above was checked against a file, per the ship-gate rule that a memory note is a hint
and never a citation. No files outside this document were written; no production value was
changed.
