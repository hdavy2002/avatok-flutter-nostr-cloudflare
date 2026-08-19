import { beforeEach, describe, expect, it, vi } from "vitest";

const { walletOp } = vi.hoisted(() => ({ walletOp: vi.fn() }));

vi.mock("../src/routes/wallet", () => ({ walletOp }));
vi.mock("../src/routes/config", () => ({
  readConfig: vi.fn(async () => ({ betaFreePremium: false })),
}));
vi.mock("../src/team_billing", () => ({
  billingUidFor: vi.fn(async (_env: unknown, uid: string) => uid),
  bumpTeamAiMsgPool: vi.fn(async () => undefined),
}));

import { chargeFeature } from "../src/feature_pricing";

describe("marketplace wallet funding policy", () => {
  beforeEach(() => {
    walletOp.mockReset();
    walletOp.mockResolvedValue({ status: 200, body: { balance: 900, paid_used: 100 } });
  });

  it("passes paid-only funding to WalletDO", async () => {
    const env = { Q_WALLET: { send: vi.fn() } } as any;
    const result = await chargeFeature(env, "seller-1", "listing_post", "listing:one:1", {
      allowFree: false,
      forceMeter: true,
    });

    expect(result).toMatchObject({ ok: true, charged: 100, balance: 900 });
    expect(walletOp).toHaveBeenCalledWith(env, "seller-1", expect.objectContaining({
      op: "spend",
      amount: 100,
      allow_free: false,
      op_id: "listing:one:1",
    }));
  });
});
