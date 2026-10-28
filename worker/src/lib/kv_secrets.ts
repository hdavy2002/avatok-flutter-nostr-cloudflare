// [HF-WIRE-18] Secrets kept in KV because the Worker is at Cloudflare's limit of 128 text bindings (secrets + vars).
// A real Worker secret always wins; otherwise the value is read once per isolate (10-minute memo) from the TOKENS KV
// namespace under "secret:<NAME>". Set with:
//   AVATOK_TARGET=prod ALLOW_PROD=1 scripts/cf.sh worker kv key put "secret:TREG_API_KEY" "<value>" --binding TOKENS --remote
// Never log the value. Readable only by the Cloudflare account, like a Worker secret.
// [HF-MERCH-PT-LOGIN-1] PRINTROVE_LOGIN (JSON {"email","password"}) lives here too and is written from the admin Print partner
// page (routes/admin2_pod_partner.ts). Values that were hydrated FROM KV are re-checked every memo window, so a changed or
// removed login reaches every isolate within ~10 minutes (the isolate that handled the save updates at once).
import type { Env } from "../types";

// [HF-FB-LOGIN-1] FACEBOOK_APP_SECRET (Meta app secret for Facebook Login) is KV too.
// [HF-IG-LOGIN-1] INSTAGRAM_APP_SECRET (Meta app secret: state signing, code exchange, signed_request) and HF_TOKEN_ENC_KEY (base64, 32 bytes: AES-GCM key for stored Instagram tokens).
const KV_SECRET_NAMES = ["TREG_API_KEY", "PRINTROVE_LOGIN", "INSTAGRAM_APP_SECRET", "HF_TOKEN_ENC_KEY", "FACEBOOK_APP_SECRET"] as const;
export type KvSecretName = (typeof KV_SECRET_NAMES)[number];
const MEMO_MS = 10 * 60 * 1000;
let memo: { at: number; values: Partial<Record<KvSecretName, string>> } | null = null;
/** Names whose current env value came from KV (not from a real Worker secret). */
const fromKv = new Set<KvSecretName>();

export const kvSecretKey = (name: KvSecretName): string => `secret:${name}`;

/** Fills env.<NAME> from KV when no Worker secret is set. Never throws. */
export async function hydrateKvSecrets(env: Env, now = Date.now()): Promise<void> {
  const wanted = KV_SECRET_NAMES.filter((n) => !String((env as any)[n] ?? "").trim() || fromKv.has(n));
  if (!wanted.length) return;
  try {
    if (!memo || now - memo.at > MEMO_MS) {
      const values: Partial<Record<KvSecretName, string>> = {};
      for (const n of KV_SECRET_NAMES) {
        const v = await env.TOKENS.get(kvSecretKey(n));
        if (v && v.trim()) values[n] = v.trim();
      }
      memo = { at: now, values };
    }
    for (const n of wanted) {
      const v = memo.values[n];
      if (v) { (env as any)[n] = v; fromKv.add(n); }
      else if (fromKv.has(n)) { delete (env as any)[n]; fromKv.delete(n); } // removed in KV since it was hydrated
    }
  } catch { /* best-effort: callers already answer provider_not_configured */ }
}

/** True when a real Worker secret (not a KV value) currently provides this name. */
export function isRealWorkerSecret(env: Env, name: KvSecretName): boolean {
  return !!String((env as any)[name] ?? "").trim() && !fromKv.has(name);
}

/** Writes the KV value and refreshes this isolate at once (no waiting for the memo). A real Worker secret still wins. */
export async function putKvSecret(env: Env, name: KvSecretName, value: string): Promise<void> {
  await env.TOKENS.put(kvSecretKey(name), value);
  if (memo) memo.values[name] = value;
  if (!isRealWorkerSecret(env, name)) { (env as any)[name] = value; fromKv.add(name); }
}

export async function deleteKvSecret(env: Env, name: KvSecretName): Promise<void> {
  await env.TOKENS.delete(kvSecretKey(name));
  if (memo) delete memo.values[name];
  if (fromKv.has(name)) { delete (env as any)[name]; fromKv.delete(name); }
}

/** Test hook. */
export function _resetKvSecretsMemo(): void { memo = null; fromKv.clear(); }
