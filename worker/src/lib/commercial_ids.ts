// Shared URL identifier contract for account-bound commercial resources.
//
// Checkout-generated consultation ids are currently
// `commercial-booking-` + a 64-character SHA-256 digest (83 characters). Keep
// this contract wider than the provider's channel limit: booking ids are our
// durable database identifiers and are never sent as a chat channel id without
// first being compacted by the commercial session route.

export const COMMERCIAL_ID_MAX_LENGTH = 160;
export const COMMERCIAL_ID_SEGMENT = `[A-Za-z0-9][A-Za-z0-9-]{0,${COMMERCIAL_ID_MAX_LENGTH - 1}}`;
export const COMMERCIAL_ID_PATTERN = new RegExp(`^${COMMERCIAL_ID_SEGMENT}$`);

export function isCommercialId(value: string): boolean {
  return value.length <= COMMERCIAL_ID_MAX_LENGTH && COMMERCIAL_ID_PATTERN.test(value);
}

/** Extract a commercial listing or booking id from the shared route shape. */
export function commercialIdFromPath(
  pathname: string,
  kind: "live" | "consult",
): string | null {
  const match = pathname.match(
    new RegExp(`^/api/commercial/${kind}/(${COMMERCIAL_ID_SEGMENT})/`),
  );
  const value = match?.[1] ?? null;
  return value && isCommercialId(value) ? value : null;
}

/** Build a route matcher using the same id segment as the handler. */
export function commercialRoutePattern(
  kind: "live" | "consult",
  suffix: string,
): RegExp {
  return new RegExp(`^/api/commercial/${kind}/${COMMERCIAL_ID_SEGMENT}/${suffix}$`);
}

