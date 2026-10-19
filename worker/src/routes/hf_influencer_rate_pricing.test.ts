// [HF-WIRE-18] HF-REEL-37: booking/call pricing bills the host's own rate while the Standard wallet plan stays on.
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("./config", () => ({ readConfig: vi.fn() }));
import * as config from "./config";
import { loadHostPricing } from "./hf_bookings";

const env = { HF_CALL_DID: "1", VOBIZ_AUTH_ID: "a", VOBIZ_AUTH_TOKEN: "b", VOBIZ_WEBHOOK_SECRET: "c" } as never;
const STD = { hfCallsEnabled: true, hfStdPlanEnabled: true, hfTokensEnabled: true, hfAppMinBuild: 2078 };
const cfg = (o: Record<string, unknown>) => vi.mocked(config.readConfig).mockResolvedValue({ ...STD, ...o } as never);
const host = (price: number) => ({ uid: "h1", category: "standard", price_per_min: price } as never);

describe("loadHostPricing with the Standard plan on", () => {
  beforeEach(() => vi.clearAllMocks());
  it("switch off: fixed Standard tariff, her own rate ignored (old behaviour)", async () => {
    cfg({ hfInfluencerSetsRate: false });
    expect((await loadHostPricing(env, host(40)))?.plan).toBe("standard");
  });
  it("switch on: bills her own rate, split by HF-REEL-30 (Rs 5 -> she gets 1.80/min; Rs 40 -> 22.80/min)", async () => {
    cfg({ hfInfluencerSetsRate: true });
    const p5 = await loadHostPricing(env, host(5));
    expect(p5?.plan).toBe("flat");
    expect(p5?.snapshot.ratePaise).toBe(500);
    expect(p5?.hostNet(60)).toBe(180);
    const p40 = await loadHostPricing(env, host(40));
    expect(p40?.snapshot.ratePaise).toBe(4000);
    expect(p40?.hostNet(60)).toBe(2280);
  });
  it("switch on: a rate under the configured minimum is not bookable", async () => {
    cfg({ hfInfluencerSetsRate: true });
    expect(await loadHostPricing(env, host(4))).toBeNull();
    cfg({ hfInfluencerSetsRate: true, hfMinRatePaise: 1000 });
    expect(await loadHostPricing(env, host(9))).toBeNull();
    expect((await loadHostPricing(env, host(10)))?.snapshot.ratePaise).toBe(1000);
  });
});
