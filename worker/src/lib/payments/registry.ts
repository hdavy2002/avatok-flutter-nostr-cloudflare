// [PAY-RAIL-1] Resolve a GatewayAdapter by id; list what this buyer can use.
import type { Env } from "../../types";
import type { PlatformConfig } from "../../routes/config";
import type { GatewayAdapter, GatewayId } from "./types";
import { razorpayAdapter } from "./razorpay";
import { paytmAdapter } from "./paytm";
import { stripeIntlAdapter } from "./stripe_intl";
import { cashfreeAdapter } from "./cashfree_adapter";

const ADAPTERS: Record<GatewayId, GatewayAdapter> = {
  razorpay: razorpayAdapter,
  paytm: paytmAdapter,
  stripe: stripeIntlAdapter,
  cashfree: cashfreeAdapter,
};

const VALID_IDS: ReadonlySet<string> = new Set(Object.keys(ADAPTERS));

export function isGatewayId(id: string): id is GatewayId {
  return VALID_IDS.has(id);
}

export function resolveGateway(id: string): GatewayAdapter | null {
  return isGatewayId(id) ? ADAPTERS[id] : null;
}

/** The platform-config flag gating each gateway. Per CLAUDE.md, a flag missing from
 *  DEFAULTS can never be flipped — routes/config.ts declares all four alongside this. */
const FLAG_FOR: Record<GatewayId, keyof PlatformConfig> = {
  razorpay: "razorpayEnabled",
  paytm: "paytmEnabled",
  stripe: "stripeIntlEnabled",
  cashfree: "cashfreeEnabled",
};

export type GatewayMethod = { gateway: GatewayId; label: string; sub: string; recommended: boolean };

const LABELS: Record<GatewayId, { label: string; sub: string }> = {
  razorpay: { label: "Razorpay", sub: "UPI · Cards · Netbanking" },
  paytm: { label: "Paytm", sub: "Paytm wallet · UPI" },
  stripe: { label: "Stripe", sub: "International cards" },
  cashfree: { label: "Cashfree", sub: "UPI · Cards" },
};

// Order matters: this is the order the buyer sees them in. Cashfree is deliberately last
// and, per spec §2.1, only ever appears if cashfreeEnabled is separately turned on — it is
// wired as a fourth adapter (commercial_refund_rail.ts already reverses to it) but is not
// part of the buyer-facing picker by default.
const PICKER_ORDER: readonly GatewayId[] = ["razorpay", "paytm", "stripe", "cashfree"];

/**
 * GET /api/pay/methods payload. `payGatewayPickerEnabled` gates the picker as a whole —
 * when it is off, the list is empty regardless of the individual gateway flags, and the
 * client renders "payments are not open yet" rather than treating an empty list as broken.
 */
export async function listEnabledMethods(env: Env, config: PlatformConfig): Promise<GatewayMethod[]> {
  if (config.payGatewayPickerEnabled !== true) return [];
  const out: GatewayMethod[] = [];
  for (const id of PICKER_ORDER) {
    if (!gatewayFlagOn(config, id)) continue;
    if (!ADAPTERS[id].configured(env)) continue;
    out.push({ gateway: id, ...LABELS[id], recommended: false });
  }
  return out;
}

/** Whether this gateway's own flag is on — independent of `payGatewayPickerEnabled`,
 *  which gates the picker UI as a whole, not each individual rail. Order-creation and
 *  webhook routes gate on this so a rail cannot be driven while its flag is off, even by
 *  a caller that bypasses the picker. */
export function gatewayFlagOn(config: PlatformConfig, id: GatewayId): boolean {
  return config[FLAG_FOR[id]] === true;
}
