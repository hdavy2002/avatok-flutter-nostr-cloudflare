// Wise (TransferWise) client for AvaPayout (Phase 4, §10.3). Thin REST wrapper.
// FLAG-GATED: production transfers require WISE_API_KEY + WISE_PROFILE_ID AND the
// PAYOUT_ENABLED flag (which stays OFF until legal clears, §10.3). Without creds
// every call is a no-op that signals unconfigured, so routes degrade to 503.
//
// Sandbox base: https://api.sandbox.transferwise.tech ; prod: https://api.wise.com
import type { Env } from "./types";

export function wiseConfigured(env: Env): boolean {
  return !!(env.WISE_API_KEY && env.WISE_PROFILE_ID);
}
function base(env: Env): string {
  return env.WISE_ENV === "production" ? "https://api.wise.com" : "https://api.sandbox.transferwise.tech";
}
async function wise<T = any>(env: Env, path: string, method: string, body?: object): Promise<T> {
  const res = await fetch(base(env) + path, {
    method,
    headers: { Authorization: `Bearer ${env.WISE_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`wise ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

// Create an INR bank recipient (India IFSC). Returns the recipient account id.
export async function createRecipient(
  env: Env,
  r: { currency: string; accountHolderName: string; ifsc: string; accountNumber: string; country: string },
): Promise<{ id: number }> {
  return wise(env, "/v1/accounts", "POST", {
    currency: r.currency,
    type: "indian",
    profile: Number(env.WISE_PROFILE_ID),
    accountHolderName: r.accountHolderName,
    details: { legalType: "PRIVATE", ifscCode: r.ifsc, accountNumber: r.accountNumber },
  });
}

// Quote source USD → target currency for a fixed source amount (USD).
export async function createQuote(env: Env, sourceUsd: number, targetCurrency: string): Promise<{ id: string }> {
  return wise(env, "/v3/profiles/" + env.WISE_PROFILE_ID + "/quotes", "POST", {
    sourceCurrency: "USD", targetCurrency, sourceAmount: sourceUsd, payOut: "BANK_TRANSFER",
  });
}

export async function createTransfer(env: Env, quoteId: string, targetAccount: number, ref: string): Promise<{ id: number }> {
  return wise(env, "/v1/transfers", "POST", {
    targetAccount, quoteUuid: quoteId, customerTransactionId: crypto.randomUUID(),
    details: { reference: ref.slice(0, 10) },
  });
}

export async function fundTransfer(env: Env, transferId: number): Promise<any> {
  return wise(env, `/v3/profiles/${env.WISE_PROFILE_ID}/transfers/${transferId}/payments`, "POST", { type: "BALANCE" });
}
