/* [WEB-COMM-PAY-1 / WEB-COMM-PAY-2] gatewaySheet — opens the picked gateway's OWN
 * payment UI for an order already created server-side via `POST /api/pay/:gateway/order`.
 *
 * [WEB-COMM-PAY-2] FIELD NAMES CORRECTED against the adapters that actually ship them
 * (worker/src/lib/payments/*.ts), which is what the previous pass had flagged as an
 * unverified guess. Each adapter's `client_payload` (per gateway):
 *
 *   - razorpay.ts createOrder(): { key_id, razorpay_order_id, amount, currency }.
 *     NOT `order_id` / `key` — Razorpay's Checkout.js options object wants `key` (the
 *     public key id) and `order_id`, so this file renames on the way in. The previous
 *     version spread `payload` directly into the options object, which would have handed
 *     Checkout.js a stray `key_id` field it does not recognise and no `key` at all.
 *   - paytm.ts createOrder(): { flow, payment_url, mid, order_id, txn_token, amount }.
 *     [PAY-PAYTM-TEST-1] The host gap flagged in the previous pass is CLOSED, by
 *     changing flows rather than by guessing better. Paytm's CheckoutJS needs a script
 *     tag at a per-merchant URL on a host only the server knows, so the client had
 *     hardcoded `securegw-stage.paytm.in` — which is now doubly wrong, since Paytm moved
 *     to paytmpayments.com. Show Payment Page needs no script: the server mints the full
 *     `payment_url` (staging or production, its choice) and the client POSTs three hidden
 *     fields to it. This NAVIGATES AWAY, so `onSettled`/`onDismiss` never fire for Paytm;
 *     `onRedirecting` does instead, and the buyer comes back through the worker's
 *     callback to /pay/return.
 *   - cashfree_adapter.ts createOrder(): { payment_session_id, order_id }. Unchanged from
 *     the previous pass — matches lib/cashfree.ts, which this adapter wraps verbatim.
 *   - stripe_intl.ts createOrder(): { client_secret, publishable_key, payment_intent_id }.
 *     NOT `checkout_url` — this Stripe lane is a PaymentIntent + Elements flow (the
 *     adapter's own header explains why: Stripe India needs a registered company, so this
 *     rail is scoped to non-INR buyers via a PaymentIntent, not a hosted Checkout Session).
 *     The previous version assumed the OTHER Stripe integration in this codebase — the
 *     wallet top-up's hosted Checkout Session redirect — and would have crashed on
 *     `payload.checkout_url` being undefined. Stripe.js is loaded from its CDN (same
 *     pattern as the other three gateways) and mounted as an inline Payment Element;
 *     see `createStripeElements` / `confirmStripePayment` below and GatewayPicker.tsx's
 *     'stripe-form' phase, which owns the mount point and the confirm button — Stripe has
 *     no analogue of "open a native sheet and get one dismiss/settle callback" the way
 *     Razorpay/Paytm/Cashfree do.
 */
import type { GatewayId, GatewayOrderResponse } from './types';

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open: () => void };
    Paytm?: {
      CheckoutJS?: {
        init: (config: Record<string, unknown>) => Promise<void>;
        invoke: () => void;
      };
    };
    Cashfree?: new (opts: Record<string, unknown>) => {
      checkout: (opts: Record<string, unknown>) => void;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Stripe?: (publishableKey: string) => any;
  }
}

const scriptCache = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  let p = scriptCache.get(src);
  if (p) return p;
  p = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(el);
  });
  scriptCache.set(src, p);
  return p;
}

export interface GatewaySheetHandlers {
  /** Called once the buyer completed the sheet — start/continue status polling. */
  onSettled: () => void;
  /** Called when the buyer closes the sheet without paying. */
  onDismiss: () => void;
  /** Called when the sheet itself can't be opened (script load failure, etc). */
  onError: (message: string) => void;
  /**
   * Called immediately before a gateway that navigates AWAY from this page takes
   * over — Paytm's Show Payment Page. There is no settle or dismiss callback
   * after this: the buyer returns via the gateway's callback to the worker,
   * which redirects to /pay/return. Persist anything the return trip needs
   * (order id, listing id) here, while the page still exists.
   */
  onRedirecting?: (order: GatewayOrderResponse) => void;
}

/**
 * Opens the gateway's own payment UI for an order already created server-side.
 * Handles razorpay / paytm / cashfree — the three gateways with a native "sheet" the
 * buyer completes in place. Stripe is NOT handled here: it has no such sheet in this
 * PaymentIntent+Elements integration — see `createStripeElements` below.
 */
export async function openGatewaySheet(
  gateway: Exclude<GatewayId, 'stripe'>,
  order: GatewayOrderResponse,
  handlers: GatewaySheetHandlers,
): Promise<void> {
  const payload = order.client_payload ?? {};
  try {
    switch (gateway) {
      case 'razorpay': {
        await loadScript('https://checkout.razorpay.com/v1/checkout.js');
        if (!window.Razorpay) throw new Error('Razorpay did not load');
        const rz = new window.Razorpay({
          key: String(payload.key_id ?? ''),
          order_id: String(payload.razorpay_order_id ?? order.gateway_order_id),
          amount: payload.amount ?? order.amount_paise,
          currency: payload.currency ?? order.currency,
          handler: () => handlers.onSettled(),
          modal: { ondismiss: () => handlers.onDismiss() },
        });
        rz.open();
        return;
      }
      case 'paytm': {
        // [PAY-PAYTM-TEST-1] Show Payment Page, not CheckoutJS.
        //
        // The first pass at this used Paytm's CheckoutJS, which needs a script
        // tag at a per-merchant URL on a host the server never told us about —
        // so it hardcoded a guess, and a wrong guess is a checkout that silently
        // never loads. Show Payment Page needs no script at all: POST three
        // fields to the URL the server minted and Paytm renders the cashier.
        // The server picks the host, which is the only place that knows whether
        // this merchant is staging or production.
        const url = String(payload.payment_url ?? '');
        const mid = String(payload.mid ?? '');
        const token = String(payload.txn_token ?? '');
        if (!url || !mid || !token) {
          throw new Error('Paytm order is missing the details needed to open the cashier');
        }

        // This NAVIGATES AWAY — there is no in-page settle callback to wait for.
        // The buyer comes back through Paytm's callback to /api/pay/paytm/webhook,
        // which redirects them to /pay/return, where the status poll picks up.
        // Tell the caller now, so it can persist whatever it needs before the
        // page unloads rather than after.
        handlers.onRedirecting?.(order);

        const form = document.createElement('form');
        form.method = 'POST';
        form.action = url;
        form.style.display = 'none';
        for (const [name, value] of Object.entries({
          mid,
          orderId: String(payload.order_id ?? order.gateway_order_id),
          txnToken: token,
        })) {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = name;
          input.value = value;
          form.appendChild(input);
        }
        document.body.appendChild(form);
        form.submit();
        return;
      }
      case 'cashfree': {
        await loadScript('https://sdk.cashfree.com/js/v3/cashfree.js');
        if (!window.Cashfree) throw new Error('Cashfree did not load');
        const mode = payload.mode === 'production' ? 'production' : 'sandbox';
        const cf = new window.Cashfree({ mode });
        cf.checkout({
          paymentSessionId: payload.payment_session_id,
          redirectTarget: '_modal',
        });
        // Cashfree's modal has no in-page settle callback in this integration
        // mode — the caller starts polling immediately after open() returns.
        handlers.onSettled();
        return;
      }
      default:
        throw new Error(`unsupported gateway: ${gateway satisfies never as string}`);
    }
  } catch (e) {
    handlers.onError(e instanceof Error ? e.message : 'Could not open the payment window.');
  }
}

// ─────────────────────────── Stripe: PaymentIntent + Elements ───────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface StripeElementsHandle {
  stripe: any;
  elements: any;
}

/**
 * Loads Stripe.js and creates an Elements instance bound to the order's PaymentIntent
 * client secret. The caller (GatewayPicker's 'stripe-form' phase) mounts a Payment
 * Element from `elements` into a container it owns, then calls `confirmStripePayment`.
 */
export async function createStripeElements(
  order: GatewayOrderResponse,
): Promise<StripeElementsHandle | { error: string }> {
  const payload = order.client_payload ?? {};
  const clientSecret = String(payload.client_secret ?? '');
  const publishableKey = String(payload.publishable_key ?? '');
  if (!clientSecret) return { error: 'This payment could not be started — missing details from the server.' };
  if (!publishableKey) return { error: 'Card payment is not fully configured yet.' };
  try {
    await loadScript('https://js.stripe.com/v3/');
  } catch {
    return { error: 'Could not load the card payment form. Check your connection and try again.' };
  }
  if (!window.Stripe) return { error: 'Could not load the card payment form.' };
  const stripe = window.Stripe(publishableKey);
  const elements = stripe.elements({ clientSecret });
  return { stripe, elements };
}

/**
 * Confirms the PaymentIntent after the buyer filled in the mounted Payment Element.
 * `redirect: 'if_required'` keeps the buyer on this page for cards that settle without
 * a redirect; only flows that genuinely need one (3DS, some redirect-based methods) leave
 * and come back via `returnUrl` — the webhook is still what actually provisions the
 * booking either way, so the poll after this resolves is what matters, not this call.
 */
export async function confirmStripePayment(
  handle: StripeElementsHandle,
  returnUrl: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { error } = await handle.stripe.confirmPayment({
      elements: handle.elements,
      confirmParams: { return_url: returnUrl },
      redirect: 'if_required',
    });
    if (error) return { ok: false, error: String(error.message || 'That card payment did not go through.') };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'That card payment did not go through.' };
  }
}
