// [AUMFE-VOICE-RUNTIME-1 2026-10-01] Pure helpers for the voice runtime (no I/O, unit-tested): the ticket gate,
// Gemini Live -> wire-protocol translation, caption/transcript bookkeeping, usage + cost maths.
import type { ServerMsg } from "./types";

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/** AGENT_ADMIN_UIDS is a comma/space separated list. */
export function parseUidList(raw: string | undefined | null): string[] {
  return (raw ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/** Open to everyone when voiceAgentsEnabled; otherwise only uids on the admin list (owner testing). */
export function canUseVoice(enabled: boolean, uid: string, adminUidsRaw: string | undefined | null, guidesPublic = false): boolean {
  if (!uid) return false;
  if (enabled || guidesPublic) return true; // [AUMFE-PREVIEW-GATE-1] guidesPublic is the shared public switch
  // adminUidsRaw: pass previewerUidsRaw(env) (ADMIN_UIDS + AGENT_ADMIN_UIDS) so every previewer qualifies.
  return parseUidList(adminUidsRaw).includes(uid);
}

export interface TicketRecord { uid: string; agent: string; email?: string | null; ts: number }

/** KV value -> record, or null when it is missing/garbled/expired (KV TTL is a floor of 60 s, so re-check age). */
export function parseTicket(raw: unknown, now: number, maxAgeMs = 90_000): TicketRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.uid !== "string" || !r.uid || typeof r.agent !== "string" || !r.agent) return null;
  const ts = typeof r.ts === "number" ? r.ts : 0;
  if (!ts || now - ts > maxAgeMs || now < ts - 5000) return null;
  return { uid: r.uid, agent: r.agent, email: typeof r.email === "string" ? r.email : null, ts };
}

// ---------------------------------------------------------------------------
// Gemini Live server message -> events
// ---------------------------------------------------------------------------

export interface GemToolCall { id: string; name: string; args: Record<string, unknown> }

export type GemEvent =
  | { kind: "setup_complete" }
  | { kind: "audio"; b64: string }
  | { kind: "input_text"; text: string }
  | { kind: "output_text"; text: string }
  | { kind: "interrupted" }
  | { kind: "turn_complete" }
  | { kind: "tool_calls"; calls: GemToolCall[] }
  | { kind: "tool_cancel"; ids: string[] }
  | { kind: "go_away"; timeLeftMs: number | null }
  | { kind: "resume_handle"; handle: string }
  | { kind: "usage"; usage: Record<string, unknown> };

/** Parse a "12s" / "12.5s" protobuf duration into ms. */
export function parseDurationMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(v);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/** One Gemini Live server frame (already JSON-parsed) -> ordered events. Unknown shapes yield []. */
export function translateGemini(msg: any): GemEvent[] {
  const out: GemEvent[] = [];
  if (!msg || typeof msg !== "object") return out;
  if (msg.setupComplete !== undefined) out.push({ kind: "setup_complete" });
  if (msg.usageMetadata && typeof msg.usageMetadata === "object") out.push({ kind: "usage", usage: msg.usageMetadata });
  const su = msg.sessionResumptionUpdate;
  if (su && su.resumable !== false && typeof su.newHandle === "string" && su.newHandle) out.push({ kind: "resume_handle", handle: su.newHandle });
  if (msg.goAway) out.push({ kind: "go_away", timeLeftMs: parseDurationMs(msg.goAway.timeLeft) });
  const tc = msg.toolCall?.functionCalls;
  if (Array.isArray(tc) && tc.length) {
    const calls: GemToolCall[] = [];
    for (const c of tc) {
      if (!c || typeof c.name !== "string") continue;
      calls.push({
        id: typeof c.id === "string" ? c.id : "",
        name: c.name,
        args: c.args && typeof c.args === "object" && !Array.isArray(c.args) ? c.args : {},
      });
    }
    if (calls.length) out.push({ kind: "tool_calls", calls });
  }
  const cancel = msg.toolCallCancellation?.ids;
  if (Array.isArray(cancel) && cancel.length) out.push({ kind: "tool_cancel", ids: cancel.filter((x: unknown) => typeof x === "string") });
  const sc = msg.serverContent;
  if (sc && typeof sc === "object") {
    if (sc.interrupted === true) out.push({ kind: "interrupted" });
    if (typeof sc.inputTranscription?.text === "string" && sc.inputTranscription.text) out.push({ kind: "input_text", text: sc.inputTranscription.text });
    const parts = sc.modelTurn?.parts;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        const d = p?.inlineData?.data;
        if (typeof d === "string" && d) out.push({ kind: "audio", b64: d });
      }
    }
    if (typeof sc.outputTranscription?.text === "string" && sc.outputTranscription.text) out.push({ kind: "output_text", text: sc.outputTranscription.text });
    if (sc.turnComplete === true) out.push({ kind: "turn_complete" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Captions + transcript
// ---------------------------------------------------------------------------

export interface TranscriptLine { who: "user" | "agent"; text: string }

/**
 * Turns streaming transcription chunks into `caption` messages. Captions carry the CUMULATIVE text of the current
 * turn for that speaker (the screen replaces, never appends), final=false while the turn is open and one final=true
 * message when it closes. Closed turns are kept as transcript lines.
 */
export class CaptionTracker {
  private user = "";
  private agent = "";
  readonly lines: TranscriptLine[] = [];

  addInput(text: string): ServerMsg[] {
    const out = this.closeAgentTurn();
    this.user += text;
    out.push({ type: "caption", who: "user", text: this.user.trimStart(), final: false });
    return out;
  }

  addOutput(text: string): ServerMsg[] {
    const out = this.closeUser();
    this.agent += text;
    out.push({ type: "caption", who: "agent", text: this.agent.trimStart(), final: false });
    return out;
  }

  /** Agent finished (turnComplete) or was cut off (interrupted): close whatever is open. */
  closeAll(): ServerMsg[] {
    return [...this.closeUser(), ...this.closeAgentTurn()];
  }

  private closeUser(): ServerMsg[] {
    const t = this.user.trim();
    this.user = "";
    if (!t) return [];
    this.lines.push({ who: "user", text: t });
    return [{ type: "caption", who: "user", text: t, final: true }];
  }

  closeAgentTurn(): ServerMsg[] {
    const t = this.agent.trim();
    this.agent = "";
    if (!t) return [];
    this.lines.push({ who: "agent", text: t });
    return [{ type: "caption", who: "agent", text: t, final: true }];
  }
}

/** "Customer: …" / "<AgentName>: …" lines, one per turn. */
export function buildTranscript(lines: TranscriptLine[], agentName: string): string {
  return lines.map((l) => `${l.who === "user" ? "Customer" : agentName}: ${l.text}`).join("\n");
}

// ---------------------------------------------------------------------------
// Usage + cost
// ---------------------------------------------------------------------------

// Same per-1M-token tariff the receptionist uses for Gemini Live (do/reception_room.ts, paid tier). The model id is
// configurable, so this is an ESTIMATE until Google publishes the exact price of the model in use.
export const LIVE_TEXT_IN_USD_PER_M = 0.75;
export const LIVE_TEXT_OUT_USD_PER_M = 4.5;
export const LIVE_AUDIO_IN_USD_PER_M = 3.0;
export const LIVE_AUDIO_OUT_USD_PER_M = 12.0;
const LIVE_AUDIO_IN_USD_PER_MIN = 0.005;
const LIVE_AUDIO_OUT_USD_PER_MIN = 0.018;

export interface LiveUsage { inAudio: number; inText: number; outAudio: number; outText: number; have: boolean }

export function emptyUsage(): LiveUsage {
  return { inAudio: 0, inText: 0, outAudio: 0, outText: 0, have: false };
}

/** usageMetadata is cumulative; the latest frame replaces the previous one. */
export function parseUsage(u: any): LiveUsage {
  const split = (details: unknown): { audio: number; text: number } => {
    const o = { audio: 0, text: 0 };
    if (Array.isArray(details)) {
      for (const d of details) {
        const n = Number((d as any)?.tokenCount) || 0;
        if (String((d as any)?.modality).toUpperCase() === "AUDIO") o.audio += n; else o.text += n;
      }
    }
    return o;
  };
  const i = split(u?.promptTokensDetails);
  const o = split(u?.responseTokensDetails ?? u?.candidatesTokensDetails);
  if (i.audio === 0 && i.text === 0 && Number(u?.promptTokenCount)) i.text = Number(u.promptTokenCount);
  if (o.audio === 0 && o.text === 0 && Number(u?.responseTokenCount)) o.text = Number(u.responseTokenCount);
  return { inAudio: i.audio, inText: i.text, outAudio: o.audio, outText: o.text, have: true };
}

/** USD estimate: token-exact when the model reported usage, else audio-seconds from byte counts (16 kHz in, 24 kHz out). */
export function liveCostUsd(u: LiveUsage, inBytes: number, outBytes: number): number {
  if (u.have) {
    return (u.inAudio / 1e6) * LIVE_AUDIO_IN_USD_PER_M + (u.outAudio / 1e6) * LIVE_AUDIO_OUT_USD_PER_M
      + (u.inText / 1e6) * LIVE_TEXT_IN_USD_PER_M + (u.outText / 1e6) * LIVE_TEXT_OUT_USD_PER_M;
  }
  return (inBytes / 32000 / 60) * LIVE_AUDIO_IN_USD_PER_MIN + (outBytes / 48000 / 60) * LIVE_AUDIO_OUT_USD_PER_MIN;
}

/** Customer-facing meter: nothing is owed inside the free seconds, then price per started-second pro rata. */
export function meterCostPaise(seconds: number, freeSeconds: number, pricePerMinPaise: number): number {
  const billable = Math.max(0, seconds - Math.max(0, freeSeconds));
  return Math.round((billable * Math.max(0, pricePerMinPaise)) / 60);
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

/** Current IST wall-clock for the system prompt, e.g. "Thursday, 1 October 2026, 14:05 IST". */
export function nowIstString(d: Date = new Date()): string {
  const f = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return `${f.format(d)} IST`;
}

/** Up to 3 short "what she remembers" lines for the call screen. */
export function rememberLines(facts: string[]): string[] {
  return facts.map((f) => f.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 3).map((f) => (f.length > 80 ? `${f.slice(0, 77)}...` : f));
}

/** Redact secrets from error text before telemetry: the Gemini Live URL carries ?key=AIza... */
export function scrubSecrets(s: string): string {
  return s
    .replace(/([?&](?:key|access_token|token|api_key)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, "[redacted-key]")
    .replace(/[A-Za-z0-9_\-]{40,}/g, "[redacted]");
}

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Cap a tool result so one fat answer cannot flood the model context. */
export function capToolResult(result: unknown, maxChars = 6000): unknown {
  let s: string;
  try { s = JSON.stringify(result ?? null); } catch { return { error: "unserializable_result" }; }
  if (s.length <= maxChars) return result ?? null;
  return { truncated: true, text: s.slice(0, maxChars) };
}
