# SPEC — Real Consultants build (2026-10-02)

Owner-approved plan: https://claude.ai/code/artifact/8e5a1a7f-b5e6-47ab-ba01-8d79a4d7e262 (Claude Doc).
Approved look (build an EXACT replica): `Specs/consultants-mockup/*.dc.html` + `aumfe.css` (the `.dc.html` files are
plain HTML with `{{…}}` holes; read them as markup). Web port of the CSS: `web/src/styles/consultants.css`
(everything scoped under `.consult-ui`). Portraits + motifs: `web/public/images/consultants/`.

## Owner rules that bite
1. **Admin-preview only.** Flag `consultantsEnabled` (default false). Gate every customer surface with
   `consultVisible(env, uid)` (worker, `lib/consultants/access.ts`) / `usePreview()` (web, `web/src/lib/preview.ts`).
   Hidden surfaces render nothing (or 404 page) for non-previewers.
2. **Brand from one file.** Never type the brand name/domain/emails — `BRAND` (worker `lib/brand`, web `lib/brand`).
3. **No green anywhere** (owner dislikes green). Use the category palettes in consultants.css. Brand teal stays as is.
4. **Hero = plain category colour**, big round portrait (400px desktop / 290px mobile), no garland, arch or patterns.
5. **Never tiny fonts** (min 13px). Nunito labels 700–900; Comfortaa headings; Baloo 2 for Devanagari. Never negative tracking.
6. **PostHog on every surface** (web `lib/analytics.ts`, worker `track`/`trackException`). Failures never silent.
7. **Seed reviews never public.** `consult_reviews.seed=1` rows are visible to previewers only, labelled "Sample".
8. **Money in rupees.** Customer pays rate + 18% GST; fee = 20% of rate; consultant wallet gets rate − fee
   (`lib/consultants/pricing.ts`). Never recompute elsewhere.
9. **No automatic refunds.** Consultant no-show → booking marked `no_show_consultant`, admin alerted, admin refunds by hand.
10. **Audio only, plain WebRTC.** No GetStream, no recording. Camera only at booking (palm / face photos).
11. **Sign-in:** consultant pages are viewable by previewers; Book requires sign-in + verified WhatsApp
    (`requireVerifiedWhatsApp`). Photos/intake are private (`DIGITAL` R2 bucket, never `BLOBS`).

## Shared contract (frozen — change only with Opus review)
- Types: `worker/src/lib/consultants/types.ts` ⇄ `web/src/lib/consultTypes.ts` (byte-identical below header;
  `python3 tool/check_consult_types.py`).
- DB: `worker/migrations/2026-10-02-consultants.sql` (+ `-seed.sql`). Tables: `consultants`, `consultant_availability`,
  `consultant_exceptions`, `consult_bookings`, `consult_photos`, `consult_file_cards`, `consult_reviews`.
- Pricing: `lib/consultants/pricing.ts` (`priceFor`). Slots: `lib/consultants/slots.ts` (`slotsFor`, IST, HOLD_MS=10 min,
  MIN_LEAD 2 h, JOIN_EARLY 10 min, GRACE_AFTER 5 min). Shared reads: `lib/consultants/store.ts`.
- Dispatcher: `worker/src/routes/consultants/index.ts` (frozen). WebSocket: `/api/consultants/ws` → `routes/consultants/ws.ts`.
- Cron: `lib/consultants/cron.ts` calls each lane's step every 5 min (frozen list).
- DO: `CONSULT_CALL` → `ConsultCallDO` (`worker/src/do/consult_call.ts`), one per booking: `idFromName(bookingId)`.

## HTTP contract (all JSON; auth = Clerk via `requireUser` unless "public")
### W1 public.ts (read)
- `GET /api/consultants/list` (public; empty list for non-previewers while dark) → `{ consultants: ConsultantCard[] }`
- `GET /api/consultants/c/:slug` → `{ consultant: ConsultantDetail, reviews: ReviewDTO[], review_pages: number, sample_reviews: boolean }`
- `GET /api/consultants/c/:slug/reviews?page=N` (5 per page, newest first) → `{ reviews, page, pages }`
- `GET /api/consultants/c/:slug/slots?from=YYYY-MM-DD&days=31` → `{ days: SlotDay[] }` (busy = live bookings)
### W1 bookings.ts (customer)
- `POST /api/consultants/bookings` `{ slug, discipline, slot_start_ms, intake: Intake, questions: string[], request_key,
  terms: true, refund_policy: true }` → 201 `{ booking: BookingDTO, pay: { upi_uri, qr_svg?, payee_vpa, amount_paise, payer_reference, expires_at } }`
  Validates: visible, live (or previewer), discipline offered, slot free (unique index), intake shape for discipline,
  WhatsApp verified. Creates status `held`, `expires_at = now + HOLD_MS`. Prices frozen from `priceFor(rate)`.
- `POST /api/consultants/bookings/:id/paid` `{ utr? }` → customer says "I've paid" (same rule as shop: 180 s → `awaiting_review`)
- `POST /api/consultants/bookings/:id/pay-wallet` → pays `total_rupees` tokens from the wallet (chargeAmount, op_id
  `consult:<id>:pay`), then confirms. 402 `insufficient` when short.
- `GET /api/consultants/bookings/mine` → `{ bookings: BookingDTO[] }`; `GET /api/consultants/bookings/:id` → `{ booking }`
- `POST /api/consultants/bookings/:id/cancel` → only while `held`/`awaiting_review` (paid cancellations go to support).
- UPI rail: mirror `routes/shop_orders.ts` exactly (unique amount via `reserveUniqueAmount`, typed UTR, SMS auto-match,
  admin confirm). Add consult candidates to the rail dispatcher `matchSaathumReceipt` the same way shop did
  (`findConsultMatchCandidates` / `confirmConsultBooking` in `lib/consultants/payment.ts`).
- On confirm (any path, first writer wins): status `confirmed`, `confirmed_at`, receipt_no, then
  `prepareBooking(env,id)` (W2) and `notifyBookingConfirmed(env,id)` (W3), both via waitUntil + cron retry.
- `expireHeldBookings` (cron): `held` past `expires_at` → `expired`, release the unique amount.
### W2 file.ts + lib/consultants/prepare/** (precompute + file)
- `POST /api/consultants/bookings/:id/photo` (owner customer; raw body JPEG/PNG ≤5 MB; header `x-photo-kind: PhotoKind`)
  → stores `DIGITAL` `consult/<booking>/<kind>.jpg`, calls AstrologyAPI vision `get-palm-id`/`get-face-id`
  (`lib/astrology` client, server-side), → `{ photo: { kind, status: 'accepted'|'rejected', reason } }`. Allowed while
  `held` (customer can retake before paying).
- `GET /api/consultants/desk/bookings/:id/file` (assigned consultant or admin) → `DeskFileDTO` (photos as short-lived
  signed URLs or a proxied `GET /api/consultants/desk/photo/:booking/:kind`).
- `PATCH /api/consultants/desk/bookings/:id/cards/:key` `{ override: any | null }` → sets/clears override (edited_by/at).
- `POST /api/consultants/desk/bookings/:id/rerun` `{ tob?: 'HH:MM' }` → re-run astrology cards (rectified birth time).
- `PUT /api/consultants/desk/bookings/:id/notes` `{ notes }`.
- `runPrepareJobs` / `prepareBooking`: per discipline, write EXACTLY `CARD_KEYS[discipline]` rows into
  `consult_file_cards` (status `missing` with a note when an endpoint fails); set `prep_status` ready/partial/failed.
  Endpoints (verified shapes in `worker/src/lib/voice_agents/packs/*.ts`, `lib/guides/astro_tools.ts`):
  astrology → birth_details, astro_details, planets, horo_chart_image/D1+D9 (or planets→chart data), current_vdasha
  + major_vdasha, manglik/kalsarpa_details/sadhesati_current_status/pitra_dosha_report, basic_panchang,
  gem_suggestion/rudraksha_suggestion/puja_suggestion, match_ashtakoot_points when partner given (geo via `geoLookup`);
  numerology → numero_table, numero_report, numero_prediction/daily (+ our own mobile / name totals);
  palmistry/face → vision readings by palm_id/face_id; tarot → tarot_predictions {love,career,finance} + yes_no_tarot,
  card names from our own 78-card table `lib/consultants/tarot_deck.ts` (W2 creates it; web reads names from the API).
  Cache everything via the astrology client cache. PostHog `consult_prepare` {ok, discipline, ms, missing:[…]}.
### W3 call.ts + ws.ts + do/consult_call.ts + lib/consultants/{settle,notify}.ts + review.ts
- `POST /api/consultants/sessions/:id/ticket` (booking's customer or consultant; booking `confirmed`/`in_call`;
  now ≥ slot_start − JOIN_EARLY) → `CallTicketDTO` (single-use ticket in KV/DO, 60 s; ICE = Cloudflare STUN +
  TURN creds minted with `TURN_KEY_ID`/`TURN_KEY_API_TOKEN`, see `routes/media.ts` ~L1365).
- WS `/api/consultants/ws?ticket=` → DO. DO: admits customer + consultant only; relays `offer/answer/ice/reveal`
  (`CallClientMsg`/`CallServerMsg`); consultant is the offerer; tracks presence intervals; writes
  `consultant_joined_at`, `customer_joined_at`, `call_started_at` (both present), `call_ended_at`, seconds; hibernatable.
  Ends on consultant `end` or slot_end + GRACE_AFTER (alarm).
- `settleDueSessions` (cron + DO end): outcome rules — both present ≥ 5 min → `completed`; consultant never joined by
  slot_start + 10 min → `no_show_consultant` (alert admin WhatsApp; strike++; NO automatic refund); consultant joined,
  customer never did by slot_start + 15 min → `no_show_customer`. Money for completed/no_show_customer: walletOp `earn`
  to the consultant uid, amount = payout, commission = fee, app_name `consult`, ref booking id,
  op_id `consult:<id>:earn` (see `ledger.ts` L165). Then thank-you (completed only) with review token.
- Notifications (WhatsApp `lib/whatsapp_send.ts`/`whatsapp_notify.ts` patterns + `enqueueEmail`): confirmed (customer
  + consultant + admin alert), day-before (both), 15-min (both), no-show alerts, thank-you + review link, review
  approved (consultant). Columns `confirm_sent_at`, `reminded_day_at`, `reminded_15_at`, `thanks_sent_at` keep it idempotent.
- `GET /api/consultants/review/:token` (public) → `{ consultant: {name, photo_url, slug}, discipline, slot_start_ms, already: boolean }`
  `POST /api/consultants/review/:token` `{ stars, text?, first_name_only: boolean }` → creates `pending` review.
### W4 desk.ts + admin.ts
- Desk (requires `consultantByUid(uid)`): `GET /api/consultants/desk/me` → `{ consultant: ConsultantDetail, rate_floor, rate_ceil }`;
  `PUT /desk/profile` {bio, tagline, languages, city} (name/photo change = admin);
  `GET/PUT /desk/availability` `{ rules: AvailabilityRule[], exceptions: AvailabilityException[], slot_minutes, buffer_minutes }`;
  `PUT /desk/rate` `{ rate }` (floor..ceil) → `{ price: PriceBreakdown }`; `GET /desk/bookings?scope=today|upcoming|past`
  → `{ bookings: DeskBookingDTO[] }`; `GET /desk/customers` → `{ customers: [...] }`; `GET /desk/earnings` → month totals.
- Admin (ADMIN_UIDS): `GET/POST /api/consultants/admin/consultants`, `PATCH …/consultants/:id` (status live/paused/draft,
  any profile field, rate floor/ceil), `POST …/consultants/:id/attach` `{ email | uid }`, `POST …/consultants/:id/photo`
  (raw image → public R2 via existing upload helper), `GET …/bookings?status=`, `POST …/bookings/:id/confirm-payment`,
  `POST …/bookings/:id/refund` `{ utr, note }` (marks refunded), `POST …/bookings/:id/cancel`,
  `GET …/reviews?status=pending|approved|rejected|seed`, `PATCH …/reviews/:id` `{ status }`.

## Web (Astro + React islands, `.folk-site` shell like /pandit; import `styles/consultants.css`; wrap in `.consult-ui`)
- F1: homepage band component (Main/HomeMobile artboards) inserted under the guides ad on `pages/index.astro`
  (renders only for previewers); `/guides/[slug]` consultant page per category (Guide*.dc.html, desktop + mobile
  responsive in one page; category theme from the consultant's first discipline, `?d=` picks another).
- F2: booking wizard `/guides/[slug]/book` (BookDetails/BookNumerology/BookPalm/BookFace/BookTarot/BookSlotPay/BookDone),
  camera capture with guidance (MediaPipe lazy-loaded from CDN only on the photo step), UPI pay panel modelled on
  `islands/shop-checkout`, wallet option, `/dashboard/consultations` list for the customer.
- F3: consultant desk `/desk` (DeskToday, DeskRate, FileAstroDesktop, FilePalmMobile, FileNumeroMobile, FileFaceMobile,
  TarotMobile) + the call client `web/src/lib/consultCall.ts` (WebRTC + WS, Wake Lock, Media Session) used by the desk
  in-call bar AND the customer page `/guides/session/[id]` (SessionCustomer).
- F4: admin pages `/admin/consultants` (list + AdminPromote form), `/admin/consultant-bookings`,
  `/admin/consultant-reviews` (AdminReviews), nav entries in `islands/admin2/nav.ts`; public review page
  `/guides/review/[token]` (ReviewMobile).

## Lanes and file ownership (never edit another lane's files; ask Opus)
| Lane | Owns |
|---|---|
| W1 | `routes/consultants/{public,bookings}.ts`, `lib/consultants/payment.ts`, consult hook lines in `routes/saathum_checkout.ts` dispatcher |
| W2 | `routes/consultants/file.ts`, `lib/consultants/prepare/**`, `lib/consultants/tarot_deck.ts` |
| W3 | `routes/consultants/{call,ws,review}.ts`, `do/consult_call.ts`, `lib/consultants/{settle,notify}.ts` |
| W4 | `routes/consultants/{desk,admin}.ts` |
| F1 | `web/src/components/consultants/**`, `web/src/pages/guides/[slug].astro`, `web/src/pages/guides/index.astro`, one insert in `pages/index.astro` |
| F2 | `web/src/islands/consult-book/**`, `web/src/pages/guides/[slug]/book.astro`, `web/src/pages/dashboard/consultations.astro`, `web/src/lib/consultApi.ts` (customer calls) |
| F3 | `web/src/islands/consult-desk/**`, `web/src/pages/desk/**`, `web/src/pages/guides/session/[id].astro`, `web/src/lib/consultCall.ts`, `web/src/lib/consultDeskApi.ts` |
| F4 | `web/src/islands/admin2/consultants/**`, `web/src/pages/admin/consultant*.astro`, `islands/admin2/nav.ts` (append), `web/src/pages/guides/review/[token].astro`, `web/src/lib/consultAdminApi.ts` |

## Definition of done (every lane)
- `cd worker && npx tsc --noEmit` clean (worker lanes); `cd web && npx astro check` or `npx tsc --noEmit` clean for
  your files (web lanes); `python3 tool/check_consult_types.py`; `python3 scripts/check_brand_literals.py`;
  `python3 tool/check_ship_readiness.py --check all`.
- Unit tests for pure logic next to the file (`*.test.ts`, vitest) — run with `cd worker && npx vitest run <file>` on macOS.
- One `tool/ship_manifest.json` entry for your issue id (append; keep others).
- Commit with `python3 scripts/git_safe_commit.py "[ISSUE-ID] …" <explicit paths>` inside YOUR worktree only.
- Do NOT deploy, do NOT apply D1 migrations, do NOT push. Opus reviews and lands.
