// [HF-WIRE-18] Secrets kept in KV because the Worker is at Cloudflare's limit of 128 text bindings (secrets + vars).
// A real Worker secret always wins; otherwise the value is read once per isolate (10-minute memo) from the TOKENS KV
// namespace under "secret:<NAME>". Set with:
//   AVATOK_TARGET=prod ALLOW_PROD=1 scripts/cf.sh worker kv key put "secret:TREG_API_KEY" "<value>" --binding TOKENS --remote
// Never log the value. Readable only by the Cloudflare account, like a Worker secret.
import type { Env } from "../types";

const KV_SECRET_NAMES = ["TREG_API_KEY"] as const;
type KvSecretName = (typeof KV_SECRET_NAMES)[number];
const MEMO_MS = 10 * 60 * 1000;
let memo: { at: number; values: Partial<Record<KvSecretName, string>> } | null = null;

/** Fills env.<NAME> from KV when no Worker secret is set. Never throws. */
export async function hydrateKvSecrets(env: Env, now = Date.now()): Promise<void> {
  const missing = KV_SECRET_NAMES.filter((n) => !String((env as any)[n] ?? "").trim());
  if (!missing.length) return;
  try {
    if (!memo || now - memo.at > MEMO_MS) {
      const values: Partial<Record<KvSecretName, string>> = {};
      for (const n of KV_SECRET_NAMES) {
        const v = await env.TOKENS.get(`secret:${n}`);
        if (v && v.trim()) values[n] = v.trim();
      }
      memo = { at: now, values };
    }
    for (const n of missing) if (memo.values[n]) (env as any)[n] = memo.values[n];
  } catch { /* best-effort: callers already answer provider_not_configured */ }
}

/** Test hook. */
export function _resetKvSecretsMemo(): void { memo = null; }
