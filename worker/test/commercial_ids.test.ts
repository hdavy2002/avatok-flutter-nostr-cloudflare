import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COMMERCIAL_ID_MAX_LENGTH,
  COMMERCIAL_ID_PATTERN,
  commercialIdFromPath,
  commercialRoutePattern,
  isCommercialId,
} from "../src/lib/commercial_ids";
import { commercialProviderIdentity } from "../src/lib/commercial_stream_sessions";

const root = resolve(import.meta.dirname, "..");
const routerSource = readFileSync(resolve(root, "src/index.ts"), "utf8");
const checkoutSource = readFileSync(resolve(root, "src/routes/commercial_checkout.ts"), "utf8");

describe("commercial resource id contract", () => {
  it("accepts the checkout-generated 83-character consultation id", () => {
    const bookingId = `commercial-booking-${"a".repeat(64)}`;
    expect(bookingId).toHaveLength(83);
    expect(isCommercialId(bookingId)).toBe(true);
    expect(commercialIdFromPath(`/api/commercial/consult/${bookingId}/prejoin`, "consult")).toBe(bookingId);
    expect(commercialRoutePattern("consult", "prejoin").test(`/api/commercial/consult/${bookingId}/prejoin`)).toBe(true);
    expect(commercialProviderIdentity({ kind: "consult_1to1", listingId: "listing-1", bookingId }).callId)
      .toBe(`consult_${bookingId}`);
    // This is the production-shaped id emitted by commercial checkout, and
    // the same shared matcher mounted by the Worker router.
    expect(checkoutSource).toContain("commercial-booking-${operationHash}");
    expect(routerSource).toContain("commercialRoutePattern");
  });

  it("rejects traversal and ids beyond the shared bound", () => {
    expect(isCommercialId("../secrets")).toBe(false);
    expect(isCommercialId(`a${"b".repeat(COMMERCIAL_ID_MAX_LENGTH)}`)).toBe(false);
    expect(COMMERCIAL_ID_PATTERN.test("-leading-hyphen")).toBe(false);
    expect(commercialIdFromPath("/api/commercial/consult/not%2Fthe-id/prejoin", "consult")).toBe(null);
  });
});
