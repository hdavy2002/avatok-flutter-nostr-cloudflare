// telephony_provider.ts — [AVA-CAMP-A1] Provider-agnostic telephony
// abstraction for outbound AI calling campaigns (Specs/OUTBOUND-AI-CALLING-
// CAMPAIGNS.md §1.4, §6.1, §7). Vobiz (Plivo-lineage) is the only concrete
// provider in v1 (see vobiz_provider.ts); this file defines the shape every
// future provider (Twilio/Plivo) must implement so campaign logic never
// touches a provider-specific REST call directly.
//
// SERVICE BOUNDARY: this module is pure types + a factory. It holds no
// telephony/billing logic itself — that lives in the concrete provider
// implementations (vobiz_provider.ts etc.) and the campaign engine that
// calls them (CampaignDO, Phase B2+).

import type { Env } from "../types";
import { VobizProvider } from "./vobiz_provider";

// ---------------------------------------------------------------------------
// Shared data types (spec §3, §6.1, §7)
// ---------------------------------------------------------------------------

/** One number available for purchase from a provider's inventory. */
export interface DidOffer {
  id: string;
  e164: string;
  country: string;
  region: string;
  setupFee: number;
  monthlyFee: number;
  currency: string;
  capabilities: { voice: boolean; sms: boolean; mms?: boolean; fax?: boolean };
}

/** A number already owned by the account (post-purchase). */
export interface PurchasedDid {
  e164: string;
  country: string;
  region: string;
  currency: string;
  setupFee: number;
  monthlyFee: number;
  status: string;          // provider-reported status, e.g. "active"
  purchasedAt: string;     // ISO timestamp
  providerMeta?: Record<string, unknown>;
}

/** Point-in-time state of one outbound/inbound call, keyed by provider call UUID. */
export interface CallState {
  callUuid: string;
  status: string;                 // provider-reported, e.g. "queued" | "ringing" | "in-progress" | "completed"
  answeredAt?: string | null;     // ISO timestamp, present once answered
  endedAt?: string | null;        // ISO timestamp, present once ended
  hangupCause?: string | null;    // raw provider cause, stored verbatim per spec §6.4
}

/** Parameters for placing one outbound call (spec §6.3 step 3, §7). */
export interface MakeCallParams {
  from: string;                 // caller ID — must be an owner-owned DID (spec §13)
  to: string;
  answerUrl: string;
  ringUrl?: string;
  hangupUrl?: string;
  /** 'true' = detect and continue with a hint; 'hangup' = auto-hangup on machine; false = disabled. */
  machineDetection?: "true" | "hangup" | false;
  machineDetectionUrl?: string;
  /** Single authority for ring timeout — do NOT also set a provider "hangup on ring" flag (spec §7). */
  ringTimeoutSec?: number;
  timeLimitSec?: number;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface TelephonyProvider {
  /** Browse purchasable numbers in the provider's inventory (spec §6.1). */
  searchNumbers(q: { country: string; contains?: string; page?: number }): Promise<{ items: DidOffer[]; total: number; page: number }>;

  /** Purchase a specific number by E.164, assigning it to this account. */
  purchaseNumber(e164: string): Promise<PurchasedDid>;

  /** Release a number back to the provider's inventory (permanent). */
  releaseNumber(e164: string): Promise<void>;

  /** Place one outbound call. Returns the provider's call UUID (spec §6.3 step 3). */
  makeCall(p: MakeCallParams): Promise<{ callUuid: string }>;

  /**
   * Read current provider-side call state. Used before any retry on an
   * uncertain makeCall (network timeout — spec §1.6 idempotency philosophy,
   * §6.3 step 3: "On timeout → getCallState(call_uuid) before any retry").
   */
  getCallState(callUuid: string): Promise<CallState>;

  /** Force-hangup a live (or cancel a queued) call. */
  hangupCall(callUuid: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory — leaves room for twilio/plivo later (spec §1.4) without touching
// campaign logic, which only ever imports this factory + the interface above.
// ---------------------------------------------------------------------------

export type TelephonyProviderName = "vobiz";

export function getTelephonyProvider(env: Env, provider: TelephonyProviderName = "vobiz"): TelephonyProvider {
  switch (provider) {
    case "vobiz":
      return new VobizProvider(env);
    default:
      throw new Error(`unknown telephony provider: ${provider as string}`);
  }
}
