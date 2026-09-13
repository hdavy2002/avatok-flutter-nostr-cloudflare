# Razorpay — what was done on 2026-09-13, in plain English

> ## ⚠️ WE ARE IN RAZORPAY **TEST MODE**
> `razorpayEnabled=true` is live in production with `rzp_test_…` keys. Any real buyer who
> picks Razorpay right now will have their real card **declined** — only Razorpay's test
> cards work. Switch to live keys, or turn the flag off, before pointing real buyers at
> it: `ALLOW_PROD=1 scripts/flags.sh set razorpayEnabled=false`.
>
> Test card: `4111 1111 1111 1111`, any future expiry, any CVV, OTP `1111`.
> Test UPI: `success@razorpay` / `failure@razorpay`.

**Status: SHIPPED.** Worker deployed to prod (version `89abc678`), web deployed via the
GitHub workflow (run `34734915762`), `razorpayEnabled` flipped on, the gateway tables
created, the secrets set. The rail is live in test mode. **One thing is still missing and
it needs you: the webhook does not exist in the Razorpay dashboard** (§4).

---

## 1. The surprise: Razorpay was already written

Nothing needed to be built from scratch. A previous session (`[PAY-RAIL-1]`,
2026-09-01) had already written the whole rail:

| Piece | Where |
|---|---|
| Razorpay adapter (create order, verify webhook, fetch order, refund) | `worker/src/lib/payments/razorpay.ts` |
| Gateway-agnostic routes `/api/pay/:gateway/{order,webhook,status}` | `worker/src/routes/pay.ts` |
| Correlation + idempotency tables | `worker/migrations/2026-09-01-gateway-orders.sql` |
| The buyer-facing picker and the Checkout.js sheet | `web/src/islands/checkout/GatewayPicker.tsx`, `gatewaySheet.ts` |

But its own header said it best: *"UNVERIFIED AGAINST A LIVE GATEWAY… no request has
ever actually been sent to Razorpay."* It had never been switched on, so nobody had
found out what was wrong with it. The work today was **making it real**, not writing it.

**First thing checked:** the test credentials work. A real order was created against
`api.razorpay.com` (`order_TbM4LEvDjMp8fP`, ₹1, test mode). The keys are good.

---

## 2. Two real bugs found and fixed (this is the committed code)

### Bug A — every successful payment would have shown "something went wrong"

After the buyer pays, the web page polls `/api/pay/:gateway/status` waiting for
good news. It treated `status === 'paid'` as success.

But `paid` is not the finish line. The order goes:

```
pending  →  paid  →  credited
             ↑         ↑
   gateway confirmed   escrow funded + ticket written  ← THIS is success
   the money
```

Those last two happen inside the *same* webhook request, milliseconds apart, so the
poll almost always sees `credited` — which the page didn't recognise. It would have
kept polling for 60 seconds and then told a buyer who had just paid that the payment
timed out. Same bug in the return page (`PayReturn.tsx`).

Fixed: success on `credited`; `paid` keeps polling (and is accepted on the last
attempt rather than showing a timeout for money that plainly moved); and
`review_pending` now says *"your payment went through but we couldn't confirm the
booking — don't pay again"* instead of *"try again"*.

### Bug B — nothing used Razorpay's instant confirmation

Razorpay hands the browser three values the moment the buyer pays:
`razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature`. The old code threw
them away and waited for the webhook. That means: slower (seconds of spinner), and
completely dead if the webhook is misconfigured, which it was — there was no webhook.

Added **`POST /api/pay/:gateway/verify`** (Razorpay only; other gateways get a 501
and keep using the webhook exactly as before). It is the step 3 you asked for:

- the signature is `HMAC-SHA256("order_id|payment_id")` using the **API key secret**
  (note: *not* the webhook secret — two different secrets, easy to mix up);
- mismatch ⇒ `400` and **nothing is written**, the order stays `pending`;
- a match is still not believed on its own: it re-reads the payment *from Razorpay*
  and refuses anything that isn't `captured` (an `authorized` payment is not money);
- it takes the **same idempotency claim** the webhook takes
  (`gateway_webhook_events`), so whichever one arrives first does the work and the
  other is a silent 200. **There is no way to double-credit a booking.**

The webhook remains the authority; this is a shortcut, not a second opinion. To make
sure the two can never drift apart, the provisioning half of the webhook handler was
lifted out verbatim into one shared function, `creditPaidGatewayOrder()`.

---

## 3. What was changed on PRODUCTION infrastructure

Both are inert until the flag is flipped — nothing a buyer can see changed.

1. **`worker/migrations/2026-09-01-gateway-orders.sql` applied to prod `avatok-meta`.**
   It had never been run, so `gateway_orders` and `gateway_webhook_events` did not
   exist. Any Razorpay or **Paytm** order would have died at the `schemaReady()` check
   with "checkout unavailable". Two empty tables now exist. *(Worth knowing:
   `paytmEnabled` and `payGatewayPickerEnabled` are already `true` in prod — so the
   Paytm rail has been advertised to buyers while being incapable of taking an order.)*
2. **Three Worker secrets set on `avatok-api` (prod):** `RAZORPAY_KEY_ID`,
   `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. The first two are your test keys;
   the third was generated here. All three are also recorded in
   `secrets/secret-values.env` (gitignored), so `secrets/deploy.sh` can re-set them.

---

## 4. What is left — one item, and it needs your hands

**The webhook does not exist in the Razorpay dashboard.** Razorpay has no API to create
one on a normal account, and both browsers available to this session refuse to drive a
payment provider's dashboard (the automation classifier blocks it, correctly). So this is
a two-minute manual job:

> Razorpay dashboard → **Account & Settings → Webhooks → Add New Webhook**
> - **URL:** `https://api.avatok.ai/api/pay/razorpay/webhook`
> - **Secret:** the `RAZORPAY_WEBHOOK_SECRET` value in `secrets/secret-values.env`
>   (it must match exactly — the Worker already holds it)
> - **Active events:** `payment.captured`, `payment.failed`, `order.paid`,
>   `refund.processed`

Until it exists, payments still work through the new `/verify` handoff (the buyer's own
browser confirms the payment), but nothing catches the cases where the browser dies mid-
payment — a closed laptop, a crashed tab, a UPI paid from another phone. **Do not run real
money through it without the webhook.**

Everything else from the previous version of this list is done:

| Was blocking | Now |
|---|---|
| `worker/src/index.ts` route registration uncommitted | committed on its own (`d3b3f9dc`, five lines, no agent-live) and deployed |
| `/api/pay/razorpay/verify` not deployed | live — returns 401 unauthenticated instead of 404 |
| `razorpayEnabled=false` | `true` in prod KV |
| nothing tested | the webhook lane is proven against the live Worker (§4b); the buyer purchase is not (§4c) |

### 4b. What WAS tested, against production

- **Credentials are real.** An order was created on `api.razorpay.com`
  (`order_TbM4LEvDjMp8fP`).
- **Signature verification works with the live secret.** A correctly signed
  `payment.captured` body → `200 {"ok":true,"ignored":"unknown order"}` (verified, parsed,
  correlated, then correctly declined to invent an order). The **same signature with one
  byte added to the body → `401 bad signature`.**
- **Replay protection works.** Sending that same event twice →
  `200 {"ok":true,"duplicate":true}` on the second. The test row was deleted afterwards.
- **Nothing else shipped.** `/api/agents/*` still 404s in production, i.e. your
  AGENT-LIVE-1 work did **not** ride along — the deploy was made from a clean worktree of
  `origin/main` plus the two payment commits only.

### 4c. The buyer purchase could not be tested, and why

A real "create listing → pay → join the call" run needs three things this session cannot
supply on its own:

1. **There are no listings.** `SELECT … WHERE status IN ('published','live')` returns
   **zero rows** in prod, so there is nothing to buy.
2. **A buyer account that is not the creator.** The checkout refuses "cannot buy your own
   service", and Chrome is signed out (`__client_uat=0`). Signing in as you means taking
   an email code out of your inbox — not something to do without you saying so.
3. **The webhook above**, for the test to prove the whole path rather than just the fast
   path.

Give me a published listing and a buyer account and the rest is a ten-minute browser run.

---

## 5. How to go live later

Nothing in the code changes. New live keys into
`ALLOW_PROD=1 scripts/cf.sh worker secret put RAZORPAY_KEY_ID` (and `…KEY_SECRET`), a new
webhook in live mode with its own secret into `RAZORPAY_WEBHOOK_SECRET`, and that is the
whole switch. Until then the flag is the safety: `razorpayEnabled=false` removes the
button from the picker.

---

## 6. Environment note for whoever picks this up next

Agents working through the Cowork device bridge run in a **Linux VM** that mounts this
macOS folder. The repo's `node_modules` are `darwin-arm64`, so `npx wrangler` inside
`worker/` dies with a workerd platform error — which makes `scripts/cf.sh` and
`scripts/flags.sh` look broken when they are fine. Workaround used today: install wrangler
in the VM (`~/wr`) and shim `npx` on `PATH`. Do not run `npm install` in the repo to "fix"
it — that would replace the Mac's own `node_modules`. The VM also has no git credentials:
pushes have to run on the Mac (Desktop Commander), by SHA, from the worktree commit.
