import { describe, expect, it } from "vitest";
import { normalizeDestination } from "../src/lib/telephony_numbers";
import { FrejunProviderError } from "../src/lib/frejun_provider";

describe("AvaCalls destination normalization", () => {
  it("accepts international and formatted national numbers", () => {
    expect(normalizeDestination("+91 (98765) 43210")?.canonical).toBe("919876543210");
    expect(normalizeDestination("020 7946 0958", "GB")?.canonical).toBe("442079460958");
    expect(normalizeDestination("001 415 555 0123", "IN")?.canonical).toBe("14155550123");
  });

  it("rejects malformed or unsupported destinations", () => {
    expect(normalizeDestination("not a phone", "IN")).toBeNull();
    expect(normalizeDestination("000", "IN")).toBeNull();
  });
});

describe("FreJun adapter safety boundary", () => {
  it("exposes a typed, non-retryable unconfigured error", () => {
    const error = new FrejunProviderError();
    expect(error.provider).toBe("frejun");
    expect(error.code).toBe("provider_unconfigured");
    expect(error.retryable).toBe(false);
    expect(error.uncertain).toBe(false);
  });
});
