# PHASE B — Auth + guest checkout + booking + dashboard (PARALLEL)

> Carry `MASTER-PROMPT.md`. Runs **simultaneously** with A, C, D, E **after** Phase 0. You build the money funnel: a fan books and pays **without a visible account step**, plus the logged-in consumer dashboard. **No commit.**

## Your goal
From `/book/<id>`, a fan picks a slot (or "join now"), is gated **only at this checkout step** (email → OTP → silent guest account), pays via the **existing Stripe flow**, and gets a confirmed booking. Browsing the marketplace stays free and ungated (Phase A) — the email gate fires here, at checkout, and nowhere earlier. Logged-in users see `/dashboard` (their bookings/tickets/upcoming). See MASTER-PROMPT §4b for the gating model and reuse Phase 0's `GuestGate`.

## Files you own (create/edit ONLY these)
```
web/src/pages/book/[id].astro        # checkout page shell
web/src/pages/dashboard.astro        # dashboard shell
web/src/pages/sign-in.astro          # Clerk sign-in page (uses lib/clerk from Phase 0)
web/src/islands/checkout/            # BookingFlow.tsx, SlotPicker.tsx, GuestEmail.tsx, PayStep.tsx, Confirmation.tsx
web/src/islands/auth/                # AuthGate.tsx (guest-vs-full gate), UpgradePrompt.tsx
web/src/islands/dashboard/           # MyBookings.tsx, TicketCard.tsx
```
Do **not** touch the shared kit, layout, nav, config, or other phases' files. You **import** `lib/clerk.tsx` and `lib/apiClient.ts` from Phase 0 read-only.

## Endpoints you use (MASTER-PROMPT §4)
- Identity: `POST /api/identity/guest`, `GET /api/identity/guest/check`, `POST /api/identity/upgrade`, `GET /api/identity/level`, `POST /api/id/email/start`, `POST /api/id/email/verify`
- Booking: `POST /api/calendar/book`, `GET /api/calendar/slots`, `POST /api/calendar/cancel`, `GET /api/calendar/events`, `GET /api/booking/list?role=&when=`
- Agent booking: `POST /api/avavoice/bookings`
- Money: `POST /api/wallet/topup` (Stripe), `GET /api/wallet/balance`, `GET /api/wallet/transactions`
- Listing detail (to show what's being booked): `GET /api/listings/:id`

> Read `worker/src/routes/booking.ts`, `worker/src/routes/calendar.ts`, `worker/src/routes/ladder.ts`, `worker/src/routes/wallet.ts` **(read only)** to confirm exact request/response field names before coding each call. **Do not edit them. Do not invent fields.**

## Steps
1. **`/book/[id]` shell** loads the listing server-side (`getListing`) so the page shows what's being booked instantly, then hydrates the `BookingFlow` island (`client:load`).
2. **BookingFlow** is a small state machine: `pick → identify → pay → confirm`.
   - **pick:** `SlotPicker` reads `/api/calendar/slots` for the listing (or "join now" for live/agent). For agents, the booking call is `/api/avavoice/bookings`; for events/consult it's `/api/calendar/book`.
   - **identify (guest checkout — use the shared gate):** call `requireGuestAuth()` from Phase 0 `lib/clerk.tsx` (it runs the email → `POST /api/id/email/start` → OTP → `POST /api/id/email/verify` → `POST /api/identity/guest` flow and returns a JWT). If a Clerk session already exists it returns immediately and you skip straight to pay. Email is captured here because we need it for booking/notification emails. Surface a quiet "set a password later" (→ `/api/identity/upgrade`) — never block on it. Do **not** rebuild the email-OTP UI; reuse `GuestGate`. (Your `GuestEmail.tsx` should be a thin wrapper around the shared gate, or dropped entirely if the shared modal suffices.)
   - **pay:** `PayStep` calls `POST /api/wallet/topup` to start the **existing Stripe** checkout/intent and completes payment with Stripe's web SDK/redirect; settlement is server-side via `/webhooks/stripe`. **Do not build a new payment system** — only drive the existing endpoint. Then call the booking endpoint (`/api/calendar/book` or `/api/avavoice/bookings`).
   - **confirm:** `Confirmation` shows the booking + a deep link to the right viewer: `/watch/<id>` (live), `/consult/<bookingId>` (consult), or `/agent/<id>` (agent). Render `<a>` only.
3. **AuthGate / UpgradePrompt:** a reusable island that, given a required action, returns the current identity level (`GET /api/identity/level`) and either lets the action proceed (guest is enough for booking) or shows `UpgradePrompt` (→ `POST /api/identity/upgrade`). Phases C/D/E may need to know "am I allowed in" — expose the gate result but **do not** build their screens.
4. **`/dashboard`** (island, requires session): `MyBookings` calls `GET /api/booking/list?role=buyer&when=upcoming|past`, renders `TicketCard`s each linking to the correct viewer path. Show wallet balance from `/api/wallet/balance`.
5. **`/sign-in`** uses the Clerk provider from Phase 0. Keep it minimal; most fans never see it (guest checkout).
6. **Errors & edge:** handle `409`/`425`/`403` from booking/join gracefully (already booked, too early, blocked). Money is sensitive — show exact amounts, never auto-retry a charge, surface failures clearly.

## Acceptance checklist
- [ ] A guest can complete `pick → email → pay (Stripe test) → confirm` and lands on a confirmation with the correct viewer link — **without** an explicit "create account" step.
- [ ] Booking calls hit the real endpoints with the real field names (verified against the route files); no invented fields.
- [ ] `/dashboard` lists a signed-in user's bookings from `/api/booking/list` and shows wallet balance.
- [ ] Money flow uses only `/api/wallet/topup` + existing Stripe; no new payment logic.
- [ ] `zine` look via kit + tokens; responsive; `cd web && npm run build` compiles your additions. No commit.

## Graphiti (then STOP)
`add_memory(group_id="proj_avaflutterapp", name="web-client PHASE-B complete — auth + guest checkout + booking + dashboard", ...)` — files, endpoints + exact fields used, the guest-checkout state machine, how AuthGate exposes identity level to other phases, any local component for Phase Z to promote. **Do not commit.**
