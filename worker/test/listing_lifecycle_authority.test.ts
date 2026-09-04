import { describe, expect, it } from "vitest";
import { isCommercialLifecycleStart } from "../src/routes/commercial_stream_sessions";
import { checkTransition } from "../src/lib/listing_transitions";

describe("listing lifecycle authority", () => {
  it("does not treat GetStream backstage session_started as livestream live", () => {
    expect(isCommercialLifecycleStart("avatok_livestream", "call.session_started")).toBe(false);
    expect(isCommercialLifecycleStart("avatok_livestream", "call.live_started")).toBe(true);
  });

  it("keeps consult start semantics", () => {
    expect(isCommercialLifecycleStart("avatok_consult", "call.session_started")).toBe(true);
    expect(isCommercialLifecycleStart("avatok_consult", "call.live_started")).toBe(false);
  });

  it("allows live only from provider-confirmed system transitions", () => {
    expect(checkTransition("published", "live", "system")).toMatchObject({ ok: true });
    expect(checkTransition("published", "live", "creator")).toMatchObject({
      ok: false,
      reason: "live_is_provider_confirmed",
    });
    expect(checkTransition("cancelled", "live", "system")).toMatchObject({ ok: false });
  });
});
