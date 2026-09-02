/* Phase B — local checkout types. These mirror the EXACT Worker shapes read
 * from worker/src/routes/calendar.ts, avavoice.ts and wallet.ts (read-only).
 * They live here (not in the shared lib) because they are checkout-internal.
 */

/** A real, bookable calendar slot row — GET /api/calendar/slots?host=<creator>. */
export interface CalendarSlot {
  id: string;
  host_uid: string;
  title: string;
  description?: string | null;
  start_at: number;
  end_at: number;
  /** Price in Tokens (1 coin = 1 cent). 0 = free. */
  price_coins: number;
  capacity: number;
  booked_count: number;
  status: 'open' | 'closed' | 'cancelled' | string;
}

/** What the picker hands up to the BookingFlow. */
export type BookSelection =
  | {
      type: 'calendar'; // legacy creator-scoped slot — POST /api/calendar/book
      slotId: string;
      title: string;
      startAt: number;
      endAt: number;
      /** Known up-front for calendar slots. */
      requiredCoins: number;
    }
  | {
      type: 'agent'; // AI agent session — POST /api/avavoice/bookings
      agentId: string;
      minutes: number;
      scheduledAt: number;
      language: string;
      title: string;
      /** Escrow is computed server-side; unknown until we try (402 → needed). */
      requiredCoins: number | null;
    }
  | {
      /* [WEB-COMM-PAY-1] The paid-session lane — POST
       * /api/commercial/{live|consult}/:listingId/checkout, then the gateway
       * picker when the wallet can't cover it. See CommercialPayStep.tsx. */
      type: 'commercial';
      kind: 'live_event' | 'consult_1to1';
      listingId: string;
      title: string;
      /** Only for consult — the picked calendar slot. Null for a live ticket. */
      slot: { start_at: number; end_at: number } | null;
      /** Client-side estimate (the listing's base price in tokens) shown before
       *  the server confirms the real total via priceBreakdown(). */
      requiredCoins: number | null;
    };

// ─────────────────────── [WEB-COMM-PAY-1] commercial checkout + pay ──────────

/** GET /api/pay/methods — SPEC §2.4. */
export type GatewayId = 'razorpay' | 'paytm' | 'stripe' | 'cashfree';

export interface PayMethod {
  gateway: GatewayId;
  label: string;
  sub: string;
  recommended: boolean;
}

export interface PayMethodsResponse {
  currency: string;
  methods: PayMethod[];
}

/**
 * POST /api/pay/:gateway/order — SPEC §2.3 GatewayOrder, as actually shipped by
 * worker/src/routes/pay.ts `payCreateOrder`. This route is SELF-SUFFICIENT: it takes
 * `{ listingId, bookingId?, slot? }`, computes the price from the listing itself, and
 * mints our order id server-side — it is never handed an existing order id from the
 * wallet checkout ([WEB-COMM-PAY-2] correction; see gatewaySheet.ts / GatewayPicker.tsx).
 *
 * `order_id` and the tax-breakdown fields (`base_amount`/`gst_amount`/`gst_rate_pct`/
 * `total_amount`, all in TOKENS not paise) are read straight off `payCreateOrder`'s JSON
 * response so the client can cross-check its own estimate against the server's real
 * number before Pay is ever enabled.
 */
export interface GatewayOrderResponse {
  ok?: boolean;
  order_id: string;
  gateway: GatewayId;
  gateway_order_id: string;
  amount_paise: number;
  currency: string;
  /** Everything the gateway's own browser SDK needs to open its sheet. */
  client_payload: Record<string, string | number>;
  /** Tokens (₹1 = 1 token) — the server's own breakdown, authoritative over any
   *  client-side estimate. */
  base_amount?: number;
  gst_amount?: number;
  gst_rate_pct?: number;
  total_amount?: number;
}

/**
 * GET /api/pay/:gateway/status?order_id=… — poll fallback while the webhook lands.
 * Matches `payStatus` in pay.ts exactly: no `booking_id`/`entitlement_id` are ever
 * returned here (the booking id, when one exists, is minted client-side — see
 * CommercialPayStep.tsx — and threaded through independently of this response).
 */
export interface PayStatusResponse {
  ok?: boolean;
  order_id: string;
  status: 'paid' | 'pending' | 'failed' | 'refunded' | string;
  listing_id?: string;
  /** Tokens (₹1 = 1 token). */
  total_amount?: number;
  error?: string | null;
}

/**
 * POST /api/commercial/{live|consult}/:listingId/checkout — success shape.
 *
 * SPEC §3.2 documents `{ order_id, amount_coins, breakdown }`. The handler
 * shipped in worker/src/routes/commercial_checkout.ts today instead returns
 * `gross_amount` / `charged_amount` / `taxable_base` / `gst_amount`. Both sets
 * of fields are declared here (all optional except `order_id`) and read
 * defensively — see CommercialPayStep.tsx.
 */
export interface CommercialCheckoutResult {
  ok?: boolean;
  order_id: string;
  booking_id?: string | null;
  entitlement_id?: string | null;
  listing_id?: string;
  kind?: string;
  currency?: string;
  starts_at?: number | null;
  ends_at?: number | null;
  // SPEC-named fields (may not be present in the shipped handler yet):
  amount_coins?: number;
  breakdown?: { base: number; fee: number; gstRatePct: number; gst: number; total: number } | null;
  // Shipped-handler fields (present today):
  gross_amount?: number;
  taxable_base?: number;
  gst_rate_pct?: number;
  gst_amount?: number;
  charged_amount?: number;
  /**
   * [LIST-FREE-1] Free-entry checkout (SPEC-2026-09-01-LISTING-CONTENT-AND-
   * BOOKING.md §D "Free join") returns the SAME shape as a paid checkout, with
   * `amount_coins`/`gross_amount`/`charged_amount` all 0 and `gateway: 'free'`.
   * Spots-remaining after this reservation, when the server sends it — field
   * name not yet finalised server-side, so both plausible spellings are read
   * defensively (see CommercialPayStep.tsx).
   */
  gateway?: string;
  spots_left?: number | null;
  seats_left?: number | null;
}

/**
 * A 402 refusal from the same endpoint — the wallet balance can't cover it.
 *
 * [WEB-COMM-PAY-2] CORRECTION: `worker/src/routes/commercial_checkout.ts:564` returns
 * exactly `{ error: 'insufficient_funds' | 'payment_failed', needed }` on this path —
 * there never was an `order_id` here to hand to a gateway. The wallet lane
 * (`POST .../checkout`) and the gateway lane (`POST /api/pay/:gateway/order`, which is
 * self-sufficient — see GatewayOrderResponse) are two independent funding rails into the
 * same provisioning code (`[PAY-HANDOFF-1]`), not a two-step "create order, then pay for
 * it". A 402 here means: stop, and offer the gateway picker instead — not "wait for an
 * order id".
 */
export interface CommercialCheckoutNeedsFunding {
  error: string; // 'insufficient_funds' | 'payment_failed'
  needed?: number;
}

/** Result returned by the booking endpoints. */
export interface BookingResult {
  ok?: boolean;
  booking_id: string;
  start_at?: number;
  end_at?: number;
  paid?: boolean;
  escrow_coins?: number;
  /** [LIST-FREE-1] Spots remaining after a free-entry reservation, when known. */
  spots_left?: number | null;
}

/** Balance shape from POST-less GET /api/wallet/balance (walletOp body). */
export interface WalletBalance {
  balance?: number;
  [k: string]: unknown;
}

/** Top-up response — POST /api/wallet/topup. */
export interface TopupResult {
  checkout_url: string;
  session_id: string;
  topup_id: string;
}

export type Step = 'pick' | 'identify' | 'pay' | 'confirm';
