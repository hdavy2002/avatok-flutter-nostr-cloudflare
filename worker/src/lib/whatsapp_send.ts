// [WA-NOTIFY-1 2026-09-28] Thin WhatsApp sender for buyer notifications (live-stream
// link, video-download link) over the same WasenderAPI account already used for
// phone-verification codes (lib/otp_sender.ts). Kept as its own module — never
// imports from or edits otp_sender.ts, which another agent owns — but mirrors its
// `wasender()` fetch helper exactly, including the 10s timeout and the
// `/on-whatsapp/:e164` fallback probe used to tell "not on WhatsApp" apart from a
// generic provider error.
//
// ⚠️ Same caveat as otp_sender.ts: WasenderAPI is an UNOFFICIAL WhatsApp gateway
// riding a real number linked by QR (Linked Devices). A burst of sends risks a
// WhatsApp ban on that number. Callers MUST NOT fire these in a tight loop —
// pacing lives in lib/whatsapp_notify.ts's outbox drain (~1 message / 2s), not here.
import type { Env } from "../types";

const WA_BASE = "https://www.wasenderapi.com/api";

export type WhatsAppSendResult =
  | { ok: true }
  | { ok: false; reason: "not_on_whatsapp" | "rate_limited" | "provider_error" | "unconfigured"; detail: string };

async function wasender(env: Env, path: string, init: RequestInit = {}): Promise<{ status: number; body: any } | null> {
  try {
    const r = await fetch(`${WA_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${env.WASENDER_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return null;
  }
}

/** Send one plain-text WhatsApp message. Never throws. */
export async function sendWhatsAppText(env: Env, e164: string, text: string): Promise<WhatsAppSendResult> {
  if (!(env.WASENDER_API_KEY ?? "").trim()) {
    return { ok: false, reason: "unconfigured", detail: "WASENDER_API_KEY not set" };
  }
  const r = await wasender(env, "/send-message", { method: "POST", body: JSON.stringify({ to: e164, text }) });
  if (r && r.status < 300 && r.body?.success === true) return { ok: true };

  const detail = r ? `${r.status} ${String(r.body?.message ?? JSON.stringify(r.body ?? "")).slice(0, 110)}` : "no_response";
  if (r?.status === 429) return { ok: false, reason: "rate_limited", detail };

  // Same probe otp_sender.ts uses: distinguish "this number isn't on WhatsApp"
  // from a generic provider failure so telemetry (and a future retry policy)
  // doesn't lump the two together.
  const chk = await wasender(env, `/on-whatsapp/${encodeURIComponent(e164)}`);
  if (chk && chk.body?.success === true && chk.body?.data?.exists === false) {
    return { ok: false, reason: "not_on_whatsapp", detail };
  }
  return { ok: false, reason: "provider_error", detail };
}
