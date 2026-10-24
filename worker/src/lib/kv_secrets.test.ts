import { beforeEach, describe, expect, it } from "vitest";
import { _resetKvSecretsMemo, deleteKvSecret, hydrateKvSecrets, isRealWorkerSecret, putKvSecret } from "./kv_secrets";
import { maskEmail, printroveLogin } from "./pod/printrove";

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
    const { env, reads } = envWith({ "secret:TREG_API_KEY": "kv" }, { TREG_API_KEY: "real", PRINTROVE_LOGIN: "real", INSTAGRAM_APP_SECRET: "real", HF_TOKEN_ENC_KEY: "real" });
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

describe("[HF-MERCH-PT-LOGIN-1] Printrove login in KV", () => {
  beforeEach(() => _resetKvSecretsMemo());
  const LOGIN = JSON.stringify({ email: "hd@gmail.com", password: "p w" });
  it("hydrates PRINTROVE_LOGIN from KV so the synchronous printroveLogin() works", async () => {
    const { env } = envWith({ "secret:PRINTROVE_LOGIN": LOGIN });
    await hydrateKvSecrets(env);
    expect(printroveLogin(env)).toEqual({ email: "hd@gmail.com", password: "p w" });
  });
  it("a real PRINTROVE_LOGIN secret wins over KV and is reported as a secret", async () => {
    const { env } = envWith({ "secret:PRINTROVE_LOGIN": LOGIN }, { PRINTROVE_LOGIN: '{"email":"s@x.test","password":"s"}', TREG_API_KEY: "t" });
    await hydrateKvSecrets(env);
    expect(printroveLogin(env)?.email).toBe("s@x.test");
    expect(isRealWorkerSecret(env, "PRINTROVE_LOGIN")).toBe(true);
  });
  it("putKvSecret writes KV and updates this isolate at once; deleteKvSecret removes both", async () => {
    const store: Record<string, string> = {};
    const env: any = { TOKENS: { get: async (k: string) => store[k] ?? null, put: async (k: string, v: string) => { store[k] = v; }, delete: async (k: string) => { delete store[k]; } } };
    await putKvSecret(env, "PRINTROVE_LOGIN", LOGIN);
    expect(store["secret:PRINTROVE_LOGIN"]).toBe(LOGIN);
    expect(printroveLogin(env)?.email).toBe("hd@gmail.com");
    expect(isRealWorkerSecret(env, "PRINTROVE_LOGIN")).toBe(false);
    await deleteKvSecret(env, "PRINTROVE_LOGIN");
    expect(store["secret:PRINTROVE_LOGIN"]).toBeUndefined();
    expect(printroveLogin(env)).toBeNull();
  });
  it("a login removed in KV disappears from an isolate after the memo window", async () => {
    const kv: Record<string, string> = { "secret:PRINTROVE_LOGIN": LOGIN };
    const env: any = { TOKENS: { get: async (k: string) => kv[k] ?? null } };
    await hydrateKvSecrets(env, 1000);
    expect(printroveLogin(env)).not.toBeNull();
    delete kv["secret:PRINTROVE_LOGIN"];
    await hydrateKvSecrets(env, 1000 + 11 * 60 * 1000);
    expect(printroveLogin(env)).toBeNull();
  });
  it("masks the email and never contains the password", () => {
    expect(maskEmail("hdavy@gmail.com")).toBe("hd•••@gmail.com");
    expect(maskEmail("a@b.co")).toBe("a•••@b.co");
    expect(maskEmail("nonsense")).toBe("•••");
  });
});
