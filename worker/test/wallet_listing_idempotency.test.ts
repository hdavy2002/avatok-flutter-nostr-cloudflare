import { describe, expect, it } from "vitest";
import {
  isPermanentWalletOpId,
  PERMANENT_WALLET_OP_PREFIX,
} from "../src/do/wallet";

describe("marketplace wallet replay retention", () => {
  it("keeps only the namespaced listing operation class beyond the generic TTL", () => {
    expect(PERMANENT_WALLET_OP_PREFIX).toBe("listing:");
    expect(isPermanentWalletOpId("listing:seller-1:1")).toBe(true);
    expect(isPermanentWalletOpId("listing:seller-1:2")).toBe(true);
    expect(isPermanentWalletOpId("ai:turn:seller-1")).toBe(false);
    expect(isPermanentWalletOpId(undefined)).toBe(false);
  });
});
