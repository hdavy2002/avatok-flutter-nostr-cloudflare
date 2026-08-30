// [COMM-FLAG-UNIFY-1] ONE answer to "is the commercial lane on for this kind", read by
// both sides of the fence.
//
// THE BUG THIS REMOVES
// --------------------
// Two files asked two different questions about the same lane:
//
//   listings.ts (the legacy `bookListing` fence)  → commercial{Live,Consult}ListingsEnabled
//   commercial_checkout.ts (the new lane)         → commercial{Live,Consult}CheckoutEnabled
//
// So with Checkout ON and Listings OFF, BOTH lanes accepted money for the same listing —
// the legacy route taking a `hold()` into `ord_*` escrow, the commercial route taking a
// second one into `commercial-order:*` escrow — with no relationship between them, two
// unrelated refund paths, and two orders for one seat. Flipping four flags in the right
// order was load-bearing, and nothing enforced it.
//
// WHY "DISAGREEMENT" IS ITS OWN STATE
// -----------------------------------
// Collapsing this to `listings && checkout` would fail SAFE but SILENTLY: with the flags
// half-flipped, buyers would get a plain "unavailable" and nobody would learn that the
// configuration is wrong. A half-configured money lane is an operator error that should
// be loud, so `mixed` is a distinct answer and callers 503 on it and emit telemetry.
// `off` (both false) is a normal, quiet state.
import type { PlatformConfig } from "../routes/config";

export type CommercialLaneKind = "live_event" | "consult_1to1";

/** `on` = both flags true. `off` = both false. `mixed` = a misconfiguration, never money. */
export type CommercialLaneState = "on" | "off" | "mixed";

export function commercialLaneState(config: PlatformConfig, kind: CommercialLaneKind): CommercialLaneState {
  const listings = kind === "live_event"
    ? config.commercialLiveListingsEnabled === true
    : config.commercialConsultListingsEnabled === true;
  const checkout = kind === "live_event"
    ? config.commercialLiveCheckoutEnabled === true
    : config.commercialConsultCheckoutEnabled === true;
  if (listings && checkout) return "on";
  if (!listings && !checkout) return "off";
  return "mixed";
}

/** The four flag values, for the telemetry that reports a `mixed` lane. */
export function commercialLaneFlags(config: PlatformConfig, kind: CommercialLaneKind): Record<string, boolean> {
  return kind === "live_event"
    ? {
      commercialLiveListingsEnabled: config.commercialLiveListingsEnabled === true,
      commercialLiveCheckoutEnabled: config.commercialLiveCheckoutEnabled === true,
    }
    : {
      commercialConsultListingsEnabled: config.commercialConsultListingsEnabled === true,
      commercialConsultCheckoutEnabled: config.commercialConsultCheckoutEnabled === true,
    };
}
