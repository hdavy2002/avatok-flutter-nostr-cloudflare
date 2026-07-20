// vobiz_provider.ts — [AVA-CAMP-A1] Vobiz (Plivo-lineage) implementation of
// TelephonyProvider (see telephony_provider.ts), used by the outbound AI
// calling campaign engine (Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md §6.1, §7).
//
// REST base https://api.vobiz.ai/api/v1, headers X-Auth-ID / X-Auth-Token
// (env.VOBIZ_AUTH_ID / env.VOBIZ_AUTH_TOKEN — same secrets pstn.ts already
// uses to fetch recording media, worker/src/routes/pstn.ts:705-708).
//
// Endpoints verified against the Vobiz docs (2026-07-20, via the vobiz-docs
// MCP — cited inline per call):
//   searchNumbers  → GET    /Account/{auth_id}/inventory/numbers?country=&search=&page=&per_page
//                    (docs: account-phone-number/list-inventory-numbers,
//                    buy-a-phone-number#1-browse-inventory)
//   purchaseNumber → POST   /Account/{auth_id}/numbers/purchase-from-inventory {e164, currency}
//                    (docs: account-phone-number/purchase-from-inventory)
//   releaseNumber  → DELETE /Account/{auth_id}/numbers/{e164}
//                    (docs: account-phone-number/unrent-number,
//                    partner/flow#release-a-phone-number)
//   makeCall       → POST   /Account/{auth_id}/Call/ {from,to,answer_url,...}
//                    (docs: call/make-call). 200/201 = QUEUED, not answered —
//                    real state arrives on ring_url/answer_url/hangup_url
//                    webhooks (spec §7). Response carries the call identifier
//                    as `request_uuid` (docs: guides/plivo-to-vobiz/endpoint-
//                    mapping shows `print(response.request_uuid)` for the
//                    Vobiz make_call response) — we also fall back to
//                    `call_uuid`/`uuid` defensively in case the REST JSON key
//                    differs from the SDK's normalized field name.
//   getCallState   → GET    /Account/{auth_id}/Call/{call_uuid}?status=live
//                    (docs: call/retrieve-live-call, compare/plivo/voice-
//                    call-api). TODO(AVA-CAMP-A1): the exact JSON response
//                    shape for a *live* call was not in the indexed docs
//                    (only the *queued* shape — call/retrieve-queued-call —
//                    and the CDR/completed shape — cdr/get-cdr — were).
//                    getCallState here tries status=live first (assumed
//                    fields: call_status/status, answer_time, end_time,
//                    hangup_cause), falls back to status=queued (call_status
//                    is always "queued" there — docs: call/retrieve-queued-
//                    call), and finally falls back to the CDR endpoint
//                    (GET /Account/{auth_id}/cdr/{call_id}, docs: cdr#get-
//                    single-cdr) for a completed call. Verify the live-call
//                    JSON shape against a real response before Phase B2 wires
//                    this into the "query-before-retry" admission path (spec
//                    §6.3 step 3) — the method SHAPE (Promise<CallState>) is
//                    correct and stable; only the live-call field names are
//                    the open question.
//   hangupCall     → DELETE /Account/{auth_id}/Call/{call_uuid}
//                    (docs: call/hangup-call, compare/plivo/voice-call-api).
//                    No request body; works for both a live call (hangup)
//                    and a still-queued call (cancel).
//   transferCall   → POST   /Account/{auth_id}/Call/{call_uuid}/
//                    {legs, aleg_url, aleg_method, bleg_url?, bleg_method?}
//                    (docs: call/transfer-call — confirmed 2026-07-20 via the
//                    vobiz-docs MCP, full param table + example bodies
//                    indexed, no uncertainty). legs defaults to "aleg" per
//                    docs; only in-progress calls can be transferred (404 if
//                    queued/ended). This is the primitive spec §7 warm human
//                    handover uses to move the caller's aleg into a
//                    <Conference> XML flow.
//
// NOTE (spec §7): "One authority for ring timeout: ring_timeout (do not also
// set hangup_on_ring)" — makeCall below deliberately never sends
// hangup_on_ring.

import type { Env } from "../types";
import type {
  TelephonyProvider, DidOffer, PurchasedDid, CallState, MakeCallParams,
} from "./telephony_provider";

const BASE = "https://api.vobiz.ai/api/v1";
const MAX_RETRIES = 3;

class VobizProviderError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "VobizProviderError";
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Jittered exponential backoff for HTTP 429 — max ~3 tries (spec: match
 *  composio.ts's cfetch retry posture; Vobiz has no documented Retry-After
 *  header in the indexed docs, so we back off blind: ~400ms, ~900ms, ~1900ms
 *  base, +0-30% jitter). Only 429 is retried here — everything else maps to
 *  a thrown VobizProviderError immediately (mirrors composio.ts's cfetch,
 *  which only auto-retries idempotent/transient failures). */
async function retryWithBackoff<T>(fn: () => Promise<T>, isRetryable: (e: unknown) => boolean): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt === MAX_RETRIES - 1) throw e;
      const base = 400 * Math.pow(2, attempt);
      const jitter = base * 0.3 * Math.random();
      await sleep(base + jitter);
    }
  }
  throw lastErr;
}

function is429(e: unknown): boolean {
  return e instanceof VobizProviderError && e.status === 429;
}

export class VobizProvider implements TelephonyProvider {
  private readonly authId: string;
  private readonly authToken: string;

  constructor(private readonly env: Env) {
    this.authId = env.VOBIZ_AUTH_ID || "";
    this.authToken = env.VOBIZ_AUTH_TOKEN || "";
  }

  private headers(): Record<string, string> {
    return {
      "X-Auth-ID": this.authId,
      "X-Auth-Token": this.authToken,
      "Content-Type": "application/json",
    };
  }

  /** One HTTP call to the Vobiz REST API, mapping non-2xx to a typed throw
   *  and retrying only HTTP 429 with jittered backoff (max 3 tries). */
  private async request(
    path: string, init?: RequestInit & { timeoutMs?: number },
  ): Promise<{ status: number; json: any }> {
    const { timeoutMs = 15000, ...rest } = init ?? {};
    return retryWithBackoff(async () => {
      let res: Response;
      try {
        res = await fetch(`${BASE}${path}`, {
          ...rest,
          headers: { ...this.headers(), ...(rest.headers as Record<string, string> | undefined) },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new VobizProviderError(`vobiz ${path} network error: ${String(e)}`, 0, null);
      }
      // 204 No Content (e.g. unrent-number, hangup-call) has no body.
      let json: any = null;
      if (res.status !== 204) {
        json = await res.json().catch(() => null);
      }
      if (!res.ok) {
        throw new VobizProviderError(
          `vobiz ${path} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
          res.status,
          json,
        );
      }
      return { status: res.status, json };
    }, is429);
  }

  // -------------------------------------------------------------------
  // DID provisioning (spec §6.1)
  // -------------------------------------------------------------------

  async searchNumbers(q: { country: string; contains?: string; page?: number }): Promise<{ items: DidOffer[]; total: number; page: number }> {
    const params = new URLSearchParams();
    params.set("country", q.country);
    if (q.contains) params.set("search", q.contains);
    params.set("page", String(q.page ?? 1));
    params.set("per_page", "25");
    const { json } = await this.request(`/Account/${this.authId}/inventory/numbers?${params.toString()}`, { method: "GET" });
    const items: DidOffer[] = (json?.items ?? []).map((it: any) => ({
      id: String(it.id ?? it.e164 ?? ""),
      e164: String(it.e164 ?? ""),
      country: String(it.country ?? q.country),
      region: String(it.region ?? ""),
      setupFee: Number(it.setup_fee ?? 0),
      monthlyFee: Number(it.monthly_fee ?? 0),
      currency: String(it.currency ?? "INR"),
      capabilities: {
        voice: Boolean(it.capabilities?.voice ?? true),
        sms: Boolean(it.capabilities?.sms ?? false),
        mms: Boolean(it.capabilities?.mms ?? false),
        fax: Boolean(it.capabilities?.fax ?? false),
      },
    }));
    return { items, total: Number(json?.total ?? items.length), page: Number(json?.page ?? q.page ?? 1) };
  }

  async purchaseNumber(e164: string): Promise<PurchasedDid> {
    const { json } = await this.request(`/Account/${this.authId}/numbers/purchase-from-inventory`, {
      method: "POST",
      body: JSON.stringify({ e164, currency: "INR" }),
    });
    // Response shape mirrors the PhoneNumber object (docs: account-phone-
    // number/list-account-phone-numbers#response-example) — defensive
    // fallbacks in case purchase-from-inventory returns a slimmer payload.
    return {
      e164: String(json?.e164 ?? e164),
      country: String(json?.country ?? ""),
      region: String(json?.region ?? ""),
      currency: String(json?.currency ?? "INR"),
      setupFee: Number(json?.setup_fee ?? 0),
      monthlyFee: Number(json?.monthly_fee ?? 0),
      status: String(json?.status ?? "active"),
      purchasedAt: String(json?.purchased_at ?? new Date().toISOString()),
      providerMeta: json ?? undefined,
    };
  }

  async releaseNumber(e164: string): Promise<void> {
    // Docs disagree on whether the path segment should be raw "+91..." or
    // %2B-encoded (unrent-number's own param doc says "without the +", but
    // its sibling assign-number endpoint explicitly warns to %2B-encode a
    // literal "+" in the path — "Failure to encode properly may result in a
    // 404 error"). encodeURIComponent is always correct here: it turns "+"
    // into "%2B" and leaves everything else in a bare E.164 string alone.
    await this.request(`/Account/${this.authId}/numbers/${encodeURIComponent(e164)}`, { method: "DELETE" });
  }

  // -------------------------------------------------------------------
  // Outbound calling (spec §6.3, §7)
  // -------------------------------------------------------------------

  async makeCall(p: MakeCallParams): Promise<{ callUuid: string }> {
    const body: Record<string, unknown> = {
      from: p.from,
      to: p.to,
      answer_url: p.answerUrl,
      answer_method: "POST",
    };
    if (p.ringUrl) { body.ring_url = p.ringUrl; body.ring_method = "POST"; }
    if (p.hangupUrl) { body.hangup_url = p.hangupUrl; body.hangup_method = "POST"; }
    if (p.machineDetection !== undefined && p.machineDetection !== false) {
      body.machine_detection = p.machineDetection; // 'true' | 'hangup'
    }
    if (p.machineDetectionUrl) {
      body.machine_detection_url = p.machineDetectionUrl;
      body.machine_detection_method = "POST";
    }
    // Deliberately NEVER set hangup_on_ring — ring_timeout is the single
    // authority for ring timeout (spec §7).
    if (p.ringTimeoutSec != null) body.ring_timeout = String(p.ringTimeoutSec);
    if (p.timeLimitSec != null) body.time_limit = String(p.timeLimitSec);

    const { json } = await this.request(`/Account/${this.authId}/Call/`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    // 200/201 here means QUEUED, not answered (spec §7) — the caller must
    // not treat this as call success; real state arrives via webhooks.
    const callUuid = String(json?.request_uuid ?? json?.call_uuid ?? json?.uuid ?? "");
    if (!callUuid) {
      throw new VobizProviderError("vobiz make-call: no call/request uuid in response", 502, json);
    }
    return { callUuid };
  }

  /**
   * TODO(AVA-CAMP-A1, see file-header note): the live-call JSON field names
   * are unverified against a real Vobiz response — this implementation is
   * defensive (multiple fallback field names) but should be smoke-tested
   * against a real live call before Phase B2 relies on it for the
   * query-before-retry admission path (spec §6.3 step 3, §1.6).
   */
  async getCallState(callUuid: string): Promise<CallState> {
    // 1) Try the live-call endpoint first — the common case while a call is
    //    ringing/in-progress (docs: call/retrieve-live-call).
    try {
      const { json } = await this.request(
        `/Account/${this.authId}/Call/${encodeURIComponent(callUuid)}?status=live`,
        { method: "GET" },
      );
      // Verified against docs (call/retrieve-live-call): the live-call object
      // is TOP-LEVEL and carries `call_status` + `session_start`. A live call
      // has NO answer_time/end_time/hangup_cause — those only exist on the CDR
      // once the call has completed (see the CDR branch below).
      return {
        callUuid,
        status: String(json?.call_status ?? json?.status ?? "live"),
        answeredAt: json?.session_start ?? null,
        endedAt: null,
        hangupCause: null,
      };
    } catch (e) {
      if (!(e instanceof VobizProviderError) || e.status !== 404) throw e;
    }
    // 2) Not live — maybe still queued (docs: call/retrieve-queued-call;
    //    call_status is always literally "queued" on this endpoint).
    try {
      const { json } = await this.request(
        `/Account/${this.authId}/Call/${encodeURIComponent(callUuid)}/?status=queued`,
        { method: "GET" },
      );
      return {
        callUuid,
        status: String(json?.call_status ?? "queued"),
        answeredAt: null,
        endedAt: null,
        hangupCause: null,
      };
    } catch (e) {
      if (!(e instanceof VobizProviderError) || e.status !== 404) throw e;
    }
    // 3) Neither live nor queued — the call has likely already completed;
    //    fall back to the CDR (docs: cdr#get-single-cdr). callUuid here is
    //    Vobiz's call_uuid, which the CDR endpoint's {call_id} path segment
    //    is documented to accept as one of the identifiers it resolves by.
    const { json } = await this.request(`/Account/${this.authId}/cdr/${encodeURIComponent(callUuid)}`, { method: "GET" });
    // Verified against docs (cdr/get-cdr): the CDR response NESTS the call
    // fields under `data` — data.answer_time / data.end_time /
    // data.hangup_cause (+ hangup_cause_code / hangup_cause_name). Reading them
    // top-level (the old code) always returned nulls.
    const d = (json?.data ?? {}) as any;
    return {
      callUuid,
      status: String(d.hangup_cause ? "completed" : "unknown"),
      answeredAt: d.answer_time ?? null,
      endedAt: d.end_time ?? null,
      hangupCause: d.hangup_cause ?? null,
    };
  }

  async hangupCall(callUuid: string): Promise<void> {
    await this.request(`/Account/${this.authId}/Call/${encodeURIComponent(callUuid)}`, { method: "DELETE" });
  }

  /**
   * Warm human handover (spec §7): transfer a live call leg to fetch fresh
   * XML from a new URL (docs: call/transfer-call, confirmed 2026-07-20).
   * Only the legs actually provided are sent — Vobiz defaults `legs` to
   * "aleg" server-side when omitted, but we pass it explicitly whenever the
   * caller specifies it to avoid relying on that default.
   */
  async transferCall(p: { callUuid: string; legs?: "aleg" | "bleg" | "both"; alegUrl?: string; blegUrl?: string; alegMethod?: string }): Promise<void> {
    const body: Record<string, unknown> = {};
    if (p.legs) body.legs = p.legs;
    if (p.alegUrl) {
      body.aleg_url = p.alegUrl;
      body.aleg_method = p.alegMethod ?? "POST";
    }
    if (p.blegUrl) {
      body.bleg_url = p.blegUrl;
      body.bleg_method = "POST";
    }
    await this.request(`/Account/${this.authId}/Call/${encodeURIComponent(p.callUuid)}/`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}
