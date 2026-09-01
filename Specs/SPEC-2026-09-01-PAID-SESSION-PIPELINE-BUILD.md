# SPEC 2026-09-01 — Paid session pipeline: the build

Owner decision, 2026-09-01. This spec closes the three breaks found in the
1 Sep pipeline audit and adds the Indian payment rails. It is the **contract**
several agents build against in parallel — where this file and an agent's
judgement disagree, this file wins, and the agent stops and says so.

Prior art that governs and is NOT re-litigated here:
`Specs/PIVOT-2026-08-27-MARKETPLACE-FIRST-PAID-SESSIONS.md`,
`Specs/SPEC-2026-08-24-PHASE-2-GETSTREAM-LIVE-CONSULT-MARKETPLACE.md`,
and `CLAUDE.md` in full.

---

## 0. The three breaks, restated as the work

| # | Break | Workstream |
|---|---|---|
| 1 | Web checkout books a legacy creator-scoped calendar slot and never calls `/api/commercial/…`, so no entitlement row is ever created | `[WEB-COMM-PAY-1]` |
| 2 | No GetStream SDK exists in `web/`, so nothing can consume the credentials the server already mints correctly | `[WEB-GS-LIVE-1]`, `[WEB-GS-CONSULT-1]` |
| 3 | Every `/j/<token>` link in every email and calendar entry has no handler in the app | `[APP-JOIN-ROUTE-1]` |

Plus the rail underneath all of it: `[PAY-RAIL-1]`.

---

## 1. Money — three gateways, one currency

**The site currency is the rupee.** Every price a buyer sees is `₹`, formatted
by `web/src/lib/money.ts` (`inr`, `inrOrFree`, `priceBreakdown`). One token is
one rupee. Nothing new computes money in dollars.

Three gateways are offered **side by side with no default** (owner decision —
the buyer picks every time):

| Gateway | Currency | Purpose |
|---|---|---|
| **Razorpay** | INR | UPI, cards, netbanking, wallets |
| **Paytm** | INR | Paytm wallet and UPI |
| **Stripe** | non-INR | international buyers only |

`Cashfree` stays wired as a fourth adapter because `commercial_refund_rail.ts`
already reverses to it and those refunds must keep working. It is not offered
in the picker unless its flag is on.

### 1.1 Amounts are integers, always

- Wire and storage: **paise** (`amount_paise`), never rupees-as-float.
- A listing's `price` is in **tokens**; `tokens × 100 = paise`.
- Stripe's non-INR path is the one place a non-rupee minor unit appears, and it
  is stored with its own `currency` so nothing downstream guesses.

### 1.2 The frozen names still apply

`CLAUDE.md` freezes every lowercase `snake_case` `*_coins` name — `amount_coins`,
`gross_coins`, `price_coins`, `escrow_coins`. **Do not rename any of them.** New
columns introduced by this spec use `_paise` because they are a genuinely new
concept (gateway charge amount), not a rename of an existing one.

---

## 2. `[PAY-RAIL-1]` — the gateway layer in `worker/`

### 2.1 Reuse, do not rewrite

`worker/src/lib/cashfree.ts` and `worker/src/routes/cashfree.ts` already
establish the exact shape this needs: create an order, verify a webhook
signature over the **raw body before parsing it**, fetch order status, refund.
The new layer generalises that shape. It does **not** replace, refactor or
reformat the Cashfree files beyond wrapping them in an adapter.

`provisionFromGatewayPurchase()` in `worker/src/routes/commercial_checkout.ts`
is the single entry point from a settled gateway payment into the commercial
lane. **It is not modified.** Every adapter's webhook ends by calling it with
the arguments it already accepts.

### 2.2 Files

```
worker/src/lib/payments/types.ts       GatewayId, GatewayAdapter, shared types
worker/src/lib/payments/registry.ts    resolve by id; list what's enabled
worker/src/lib/payments/razorpay.ts    adapter
worker/src/lib/payments/paytm.ts       adapter
worker/src/lib/payments/stripe_intl.ts adapter (international, non-INR)
worker/src/lib/payments/cashfree_adapter.ts  thin wrapper over the existing lib
worker/src/routes/pay.ts               the generic routes
worker/migrations/2026-09-01-gateway-orders.sql
```

### 2.3 The adapter interface

```ts
export type GatewayId = 'razorpay' | 'paytm' | 'stripe' | 'cashfree';

export interface GatewayOrder {
  gateway: GatewayId;
  gateway_order_id: string;
  amount_paise: number;
  currency: string;          // 'INR' for razorpay/paytm/cashfree
  /** Everything the browser SDK needs to open the sheet. Never a secret. */
  client_payload: Record<string, string | number>;
}

export interface GatewayAdapter {
  readonly id: GatewayId;
  configured(env: Env): boolean;
  createOrder(env: Env, a: {
    orderId: string;           // OUR order id — becomes the gateway's receipt/notes
    amountPaise: number;
    currency: string;
    uid: string;
    listingId: string;
    kind: 'live_event' | 'consult_1to1';
  }): Promise<GatewayOrder | { error: string; status: number }>;
  /** Verify over the RAW body. Must not parse before verifying. */
  verifyWebhook(env: Env, raw: string, headers: Headers): Promise<boolean>;
  parseWebhook(raw: string): {
    gateway_order_id: string;
    our_order_id: string;
    status: 'paid' | 'failed' | 'refunded' | 'pending';
    amount_paise: number;
    currency: string;
    gateway_payment_id: string | null;
  } | null;
  fetchOrder(env: Env, gatewayOrderId: string): Promise<{ status: string; amount_paise: number } | null>;
  refund(env: Env, a: { gatewayOrderId: string; amountPaise: number; reason: string; opId: string }):
    Promise<{ accepted: boolean; gateway_refund_id: string | null; error?: string }>;
}
```

### 2.4 Routes

```
GET  /api/pay/methods                 → what this buyer can use
POST /api/pay/:gateway/order          → create an order for an existing our-order-id
POST /api/pay/:gateway/webhook        → verify raw, then provision
GET  /api/pay/:gateway/status         → poll fallback when the webhook is late
```

`GET /api/pay/methods` returns, for the calling user:

```json
{
  "currency": "INR",
  "methods": [
    { "gateway": "razorpay", "label": "Razorpay", "sub": "UPI · Cards · Netbanking", "recommended": false },
    { "gateway": "paytm",    "label": "Paytm",    "sub": "Paytm wallet · UPI",       "recommended": false },
    { "gateway": "stripe",   "label": "Stripe",   "sub": "International cards",      "recommended": false }
  ]
}
```

`recommended` is `false` on every entry today — the owner's decision is no
default. The field exists so a default can be turned on later without the
client changing shape. Only gateways whose flag is on **and** whose secrets are
configured appear at all; an empty list is a legitimate answer and the client
must render it as "payments are not open yet", not as an error.

The existing `/api/pay/cashfree/*` routes stay registered and working. The new
generic routes sit beside them.

### 2.5 Webhook rules — non-negotiable

1. **Read the raw body once, verify the signature over it, and only then parse.**
   The existing Cashfree route comment in `worker/src/index.ts:1149` says this
   for a reason. Any adapter that `await req.json()`s first is wrong.
2. **Idempotent.** A gateway will deliver the same event more than once. Key on
   `(gateway, gateway_payment_id)`; a replay is a 200 with no side effect.
3. **A 200 from a refund call means accepted, not refunded.** The existing
   `commercial_refund_rail.ts` already models this correctly — match it.
4. Amount is verified against our stored order before provisioning. A mismatch
   is a hard failure into `review_pending`, never a silent accept.

### 2.6 Flags — declare them in BOTH places or they are fake

Per `CLAUDE.md`, a flag the client reads but `config.ts` does not declare can
never be flipped. Every one of these goes in the `PlatformConfig` interface
**and** in `DEFAULTS`:

```
razorpayEnabled       false
paytmEnabled          false
stripeIntlEnabled     false
payGatewayPickerEnabled false     // the web picker as a whole
```

Prove each one: `ALLOW_PROD=1 scripts/flags.sh set <key>=false` must not 400.
Do not run that during the build — it is a production write. Just make sure the
key is declared so it *can* be set.

### 2.7 Secrets

Names only, set by the owner in `wrangler secret put`. Never committed, never
logged, never echoed into an error message:

```
RAZORPAY_KEY_ID  RAZORPAY_KEY_SECRET  RAZORPAY_WEBHOOK_SECRET
PAYTM_MID  PAYTM_MERCHANT_KEY  PAYTM_WEBSITE
STRIPE_SECRET_KEY  STRIPE_WEBHOOK_SECRET
```

`configured(env)` returns false when any of an adapter's secrets are missing,
and the gateway simply does not appear in `/api/pay/methods`.

---

## 3. `[WEB-COMM-PAY-1]` — checkout repointed

### 3.1 The branch

`web/src/islands/checkout/SlotPicker.tsx:54-58` currently sends every
non-agent listing to the legacy calendar lane. It becomes:

- `kind === 'agent'` → `AgentForm` (unchanged)
- `kind === 'live_event'` → the ticket path — no slot picking, the event has one
  time; the buyer is choosing to attend, not to schedule
- `kind === 'consult'` → the slot path, but the selected `{start_at, end_at}` is
  passed to the commercial checkout as `body.slot`, which is what
  `commercial_checkout.ts:375` already expects
- everything else → `CalendarSlots` (unchanged legacy behaviour)

### 3.2 The call sequence

```
POST /api/commercial/{live|consult}/:listingId/checkout
  headers: Authorization: Bearer <clerk jwt>, Idempotency-Key: <uuid v4, stable per attempt>
  body:    { accept_policy: true, slot?: { start_at, end_at } }
  →        { order_id, amount_coins, breakdown, ... }

POST /api/pay/:gateway/order   { order_id }
  →   { gateway_order_id, amount_paise, currency, client_payload }

  ...open the gateway's own sheet with client_payload...

GET  /api/pay/:gateway/status?order_id=…   ← poll while the webhook lands
```

**The `Idempotency-Key` is generated once per checkout attempt and reused on
retry.** A new key for a retry creates a second order; `commercial_checkout.ts:414`
returns 409 for a reused key with a *different* body, which is the behaviour we
want and must not fight.

`accept_policy` must be a real, ticked checkbox with the cancellation terms
visible next to it — not a hardcoded `true`. The server rejects `false`, and the
policy is snapshotted immutably at this moment, so what the buyer saw is what
binds.

### 3.3 The gateway picker

New island `web/src/islands/checkout/GatewayPicker.tsx`.

- Reads `GET /api/pay/methods`. Renders the returned gateways **side by side, in
  the order given, with none preselected.** The buyer must actively choose; the
  Pay button stays disabled until they do.
- Each option shows the gateway name and what it accepts (`UPI · Cards ·
  Netbanking`), not a logo wall. Keyboard-operable radio semantics, visible
  focus ring.
- Empty list → "Payments aren't open yet" with the listing still bookable-looking
  but the button disabled. This is today's state and must not look like a bug.
- The total shown here comes from `priceBreakdown()` in `money.ts` and must
  match the server's `amount_coins` to the rupee. If they disagree, show the
  server's number and stop — never charge a number the buyer did not see.

### 3.4 Error copy

Map the server's error codes to sentences a buyer can act on. No raw codes on
screen. At minimum: `ticket already owned`, `consultation already booked`,
`booking notice policy`, `price changed since payment`, `commercial checkout
disabled`, `lane_misconfigured`. Extend `web/src/lib/listingErrors.ts` rather
than inventing a second mapping.

---

## 4. `[WEB-GS-LIVE-1]` and `[WEB-GS-CONSULT-1]` — the browser sessions

### 4.1 Shared, and owned by neither agent

`@stream-io/video-react-sdk@1.42.0` is added to `web/package.json` and
`web/src/lib/getstream.ts` is written **before** either agent starts. Neither
agent edits `package.json`, and neither rewrites `getstream.ts` — if it is
missing something, say so rather than forking it.

`getstream.ts` exposes exactly:

```ts
joinCommercialSession(kind: 'live' | 'consult', id: string, jwt: string)
  → { apiKey, userId, token, callType, callId, role, session_id }
     | { error: string; status: number }

streamClientFor(creds)  → StreamVideoClient   (memoised per user)
```

It calls `POST /api/commercial/live/:id/join` or
`POST /api/commercial/consult/:id/join` and returns exactly what the server
gives back. **The client never constructs a call type or call id.** Those are
minted server-side in `worker/src/lib/commercial_stream_sessions.ts` and a
client that guesses them is a bug, not a shortcut.

### 4.2 The server's answers the UI must handle

`authorizeProviderJoin` has real states and each one deserves its own screen,
not a generic toast:

| Response | Screen |
|---|---|
| `425 too_early` | Countdown to the join window, with the creator's name and the start time |
| `410 too_late` / session `ended` | "This session has ended", with a link to the receipt |
| `403 ticket required` | The buy path — this is the pay-to-join-late case, send them to checkout with the listing preloaded |
| `403 not your booking` | "This consultation is booked for someone else" |
| `404` join disabled | "Not open yet" |
| success | join the call |

The `403 ticket required` branch is a **feature, not an error**:
`commercial_checkout.ts:350` explicitly allows buying while the listing is
already `live`. A viewer who arrives mid-stream should be able to pay and be
watching within one flow.

### 4.3 Live watch page — `[WEB-GS-LIVE-1]`

- Route: `web/src/pages/live/[id].astro`, `prerender = false`. The existing
  `/watch/[id]` (Cloudflare Stream Live) is **left alone** — it still serves the
  old lane and deleting it is a separate decision.
- Viewer joins with role `viewer`; the SDK renders the host's published tracks.
  No local camera or mic is ever requested for a viewer.
- Chrome: creator name and avatar, live badge with elapsed time, viewer count,
  chat, and a leave control. Reuse the presentation of the existing
  `web/src/islands/live/` components where it fits — this is a new transport, not
  a new brand.
- Reconnect: the SDK handles retries; the UI shows "Reconnecting…" rather than a
  frozen frame, and offers a manual retry after a sustained failure.

### 4.4 Consult room — `[WEB-GS-CONSULT-1]`

- Route: `web/src/pages/session/[booking].astro`, `prerender = false`. The
  existing `/consult/[booking]` is left alone for the same reason.
- **Reuse `web/src/islands/consult/PreJoin.tsx`.** It already does the
  `getUserMedia` preflight, device enumeration, mute and camera toggles and the
  `NotAllowedError` / `NotFoundError` copy. It is provider-agnostic; port it,
  don't rewrite it.
- In the call: both parties' video, mute, camera, leave, and a **visible session
  timer counting down to the booked end**. The buyer is paying for a block of
  time and must be able to see it.
- Extend time: `POST /api/commercial/consult/:id/extend/quote` then
  `/extend/confirm`. The flow is already built server-side with dual consent and
  escrow — the UI shows the quote in rupees, asks both sides, and reflects the
  new end time on the timer. Never confirm an extension the buyer has not seen
  priced.

### 4.5 What neither agent does

- Does not touch `worker/`.
- Does not change any existing page under `web/src/pages/watch/` or
  `web/src/pages/consult/`.
- Does not add a Cloudflare media fallback to the paid lane. Failing closed is
  the specified behaviour; an unmetered session is a money bug.

---

## 5. `[APP-JOIN-ROUTE-1]` — the dead link

### 5.1 The handler

`app/lib/core/deep_links.dart` gains a case for `host == 'avatok.ai' && path
startsWith '/j/'` and for `avatok://j/<token>`. It:

1. Calls `GET /api/join-info/:token` for the booking id, listing id and kind.
2. Resolves whether the signed-in user is the **creator** or the **buyer** for
   that booking.
3. Routes accordingly:
   - creator + `live_event` → `LiveReadinessScreen`
   - creator + `consult` → `CommercialConsultationPrejoinScreen(isCreator: true)`
   - buyer → the existing viewer screens
   - signed out → the sign-in gate, then resume to the same destination

`MySessionsScreen._join()` in
`app/lib/features/booking/commercial_customer_screens.dart:452-483` currently
opens the viewer screens unconditionally. It gains the same creator branch, so
both entry points agree.

### 5.2 The manifest

`app/android/app/src/main/AndroidManifest.xml` declares `/j/` as a verified App
Link but not `/session`. Add the `/session` filter so the handler that already
exists at `deep_links.dart:161-177` is reachable over https, not only via the
custom scheme nothing generates.

### 5.3 Design guard

Any new Flutter widget obeys the two automated checks: no raw colour literals
(use an `AD.*` token from `core/ui/avatok_dark.dart`), no bare Material
`Icons.*` (use `PhosphorIcons`). Run
`python3 tool/check_design_guard.py --check all` before committing. **Do not run
`--update-baseline`.**

---

## 6. Rules every agent follows

1. **Compile before you claim.** `npx tsc --noEmit` in `worker/`; `npx tsc
   --noEmit` (or `npm run build`) in `web/`; `flutter analyze` in `app/`. A green
   deploy is not a green typecheck — wrangler strips types without checking them.
2. **Commit through the wrapper, with your own paths only.**
   `python3 scripts/git_safe_commit.py "[ISSUE-ID] message" path/one path/two`.
   Never bare `git add`/`git commit`. One issue per commit. The tree is shared —
   passing explicit paths is what stops you sweeping another agent's files in.
3. **Do not push.** Pushing is the reviewer's call once everything compiles
   together.
4. **Do not deploy anything.** No `wrangler`, no `scripts/cf.sh`, no
   `gh workflow run`. No production writes, no flag flips.
5. **Do not touch another workstream's files.** If you need something from one,
   say so and stop.
6. **New behaviour ships dark.** Every flag introduced defaults to `false`.
7. **Telemetry, per `CLAUDE.md`.** New async or network paths report failures
   through `Analytics.captureException` (client) or `hooks.trackException`
   (worker). No silent `catch {}`.
8. **Write down the success value before you finish.** For anything two-sided,
   add a `tool/ship_manifest.json` entry naming the event and the exact property
   value that means it worked. "Events are flowing" is not evidence.

---

## 7. Sequence

```
[PAY-RAIL-1] ──────────────┐
                           ├──► [WEB-COMM-PAY-1] ──► buyer can pay in ₹
shared getstream.ts ───────┤
                           ├──► [WEB-GS-LIVE-1]    ──► buyer can watch
                           └──► [WEB-GS-CONSULT-1] ──► buyer can talk

[APP-JOIN-ROUTE-1] ─────────────────────────────────► links work, creator starts
```

Then, not in this pass and deliberately deferred: timezone on listings, the
commercial-consult reminder email, live-event seat cap and auto-end, the consult
availability model, payouts through a real API, TDS, and chargebacks. Each is
listed in the 1 Sep audit with its reasoning.
