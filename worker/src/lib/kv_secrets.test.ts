import { beforeEach, describe, expect, it } from "vitest";
import { _resetKvSecretsMemo, hydrateKvSecrets } from "./kv_secrets";

function envWith(kv: Record<string, string>, extra: Record<string, unknown> = {}) {
  let reads = 0;
  const env: any = { TOKENS: { get: async (k: string) => { reads++; return kv[k] ?? null; } }, ...extra };
  return { env, reads: () => reads };
}

describe("[HF-WIRE-18] KV-held secrets", () => {
  beforeEach(() => _resetKvSecretsMemo());
  it("fills TREG_API_KEY from KV when no Worker secret is set", async () => {
    const { env } = envWith({ "secret:TREG_API_KEY": " abc " });
    await hydrateKvSecrets(env);
    expect(env.TREG_API_KEY).toBe("abc");
  });
  it("a real Worker secret wins and KV is not read", async () => {
    const { env, reads } = envWith({ "secret:TREG_API_KEY": "kv" }, { TREG_API_KEY: "real" });
    await hydrateKvSecrets(env);
    expect(env.TREG_API_KEY).toBe("real");
    expect(reads()).toBe(0);
  });
  it("memoises per isolate and never throws", async () => {
    const a = envWith({ "secret:TREG_API_KEY": "abc" });
    await hydrateKvSecrets(a.env, 1000);
    const b = envWith({});
    await hydrateKvSecrets(b.env, 2000);
    expect(b.env.TREG_API_KEY).toBe("abc");
    expect(b.reads()).toBe(0);
    _resetKvSecretsMemo();
    const c: any = { TOKENS: { get: async () => { throw new Error("kv down"); } } };
    await expect(hydrateKvSecrets(c)).resolves.toBeUndefined();
  });
});
