// AVACALLS-006 — FreJun adapter boundary.
// The provider contract is deliberately not guessed until an approved sandbox
// contract is verified. This adapter therefore fails closed and never leaks
// provider-shaped payloads into domain routes.
import type { Env } from "../types";
import type { CallState, DidOffer, MakeCallParams, PurchasedDid, TelephonyProvider } from "./telephony_provider";

export class FrejunProviderError extends Error {
  readonly provider = "frejun" as const;
  readonly code: string;
  readonly retryable: boolean;
  readonly uncertain: boolean;
  constructor(code = "provider_unconfigured", message = "FreJun adapter is not configured", retryable = false, uncertain = false) {
    super(message);
    this.name = "FrejunProviderError";
    this.code = code;
    this.retryable = retryable;
    this.uncertain = uncertain;
  }
}
function unavailable(): never { throw new FrejunProviderError(); }

export class FrejunProvider implements TelephonyProvider {
  constructor(private readonly env: Env) { void this.env; }
  async searchNumbers(_q: { country: string; contains?: string; page?: number }): Promise<{ items: DidOffer[]; total: number; page: number }> { return unavailable(); }
  async purchaseNumber(_e164: string): Promise<PurchasedDid> { return unavailable(); }
  async releaseNumber(_e164: string): Promise<void> { return unavailable(); }
  async makeCall(_p: MakeCallParams): Promise<{ callUuid: string }> { return unavailable(); }
  async getCallState(_callUuid: string): Promise<CallState> { return unavailable(); }
  async hangupCall(_callUuid: string): Promise<void> { return unavailable(); }
  async transferCall(_p: { callUuid: string; legs?: "aleg" | "bleg" | "both"; alegUrl?: string; blegUrl?: string; alegMethod?: string }): Promise<void> { return unavailable(); }
}
