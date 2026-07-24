// [TEST-FAILURE-INJECT-1] Server-side failure injection (F11, v1) — consumers copy.
//
// Mirrors worker/src/lib/fault_inject.ts byte-for-byte in behavior. Duplicated
// (not imported) because worker/ and consumers/ are separately deployed
// Cloudflare Workers with their own tsconfig/bundle — cross-package imports
// between them are not supported here (see the LivenessVerifyMsg comment in
// consumers/src/types.ts for the same constraint on shared code).
//
// ENV-ONLY switch, deliberately NOT a KV/config flag — it can only be enabled by
// setting FAULT_INJECT in consumers/wrangler.toml and REDEPLOYING, never by a
// remote KV write.
import type { Env } from "./types";

export function shouldFail(env: Env, point: string): boolean {
  const raw = (env as unknown as { FAULT_INJECT?: string }).FAULT_INJECT;
  if (!raw || typeof raw !== "string") return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(point);
}
