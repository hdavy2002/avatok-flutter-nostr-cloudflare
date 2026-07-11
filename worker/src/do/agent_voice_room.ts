// AgentVoiceRoom — the Ava AI Voice Agent call bridge (WP4, plan §4/§5/§6/§15.1/
// §15.4/§15.5 of Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md).
//
// Modeled on do/reception_room_cf.ts's / do/voicemail_room.ts's call-participant
// mechanics (WS join as the second peer, PCM16 audio in/out, 2-peer cap
// preserved — this bot occupies the SECOND slot, caller + bot, never a call
// with two humans already on it), but the BRAIN here is a Grok Voice Agent
// REALTIME session, not Workers AI. This DO is a thin bridge:
//   caller WS (PCM16 in/out)  <-->  AgentVoiceRoom DO  <-->  Grok realtime WS
// Grok drives the conversation, RAG (`file_search` over the owner's
// Collection), and decides WHEN to call a tool; this DO only executes the
// custom function side effects (create_booking / send_email / other Composio
// tools from the profile's tool_manifest) and relays audio both ways.
//
// Grok realtime wire protocol — VERIFIED against docs.x.ai on 2026-07-11
// (fetched https://docs.x.ai/developers/model-capabilities/audio/voice-agent.md
// directly). It is OpenAI-Realtime-shaped but xAI's *current* event names
// use the output-prefixed GA scheme, not the older `response.audio.delta`
// beta names this file used before:
//   - session.update / input_audio_buffer.append — unchanged, doc-confirmed.
//   - response.audio.delta        → response.output_audio.delta (doc-confirmed,
//     appears verbatim in the doc's own function-call-handling code sample).
//   - response.audio_transcript.delta → response.output_audio_transcript.delta
//     (same output-prefixed rename family; not spelled out verbatim in the
//     fetched page, so both the new and legacy name are accepted defensively).
//   - conversation.item.input_audio_transcription.completed — kept: xAI's
//     doc only renames the incremental *delta* variant to `.updated`
//     (cumulative transcript); `.completed` isn't listed as unsupported.
//   - response.function_call_arguments.done — doc-confirmed (exact event
//     table: "Function Call Events").
// Every Grok-facing send/receive stays defensive (try/catch, no throw) so a
// wire-shape drift degrades to "this call falls back to voicemail" rather
// than crashing the Worker.
//
// Wallet: Mode A holds 30 tokens BEFORE this DO is even started (routes/
// agent_voice_routes.ts calls holdForAgentModeA — mirrors voicemailStart's
// pattern of doing validation/holds in the route, not the DO). Mode B's
// escrow is already held by the caller flow before routing ever reaches
// "agent". This DO settles per delivered minute (lib/call_billing.ts
// settleCallMinute) and refunds whatever's left in escrow at finalize
// (refundUnused) — one money path for every call type (plan §15.3).
import type { Env } from "../types";
import { trackUserContact } from "../hooks";
import { contactFor } from "../lib/identity";
import { emitCallEvent, EVENT_SCHEMA_VERSION, newTraceId, withSpan, type ReasonCode } from "../lib/call_events";
import { settleCallMinute, refundUnused } from "../lib/call_billing";
import type { CallSnapshot } from "../lib/call_snapshot";
import { releaseAgentSlot } from "../lib/call_routing";
import { realtimeUrl, buildSessionUpdate, buildWrapUpNudge, type GrokTool } from "../lib/grok";
import { loadCallerMemory, writeCallSummary } from "../lib/mem0";
import { readConfig } from "../routes/config";
import { executeTool } from "../lib/composio";
import type { BookingAuthority } from "../routes/agent_profiles";

const TOOL_CALL_TIMEOUT_MS = 10_000; // plan §11 TOOL_CALL_TIMEOUT = 10s (no config.ts field yet — hardcoded per plan value)
const MINUTE_MS = 60_000;
const MAX_REC_BYTES = 12 * 1024 * 1024;

// Fixed, non-editable disclosure prefix (plan §15.4 — mandatory, covers
// bot-disclosure + recording-consent in one sentence). The owner's
// instructions ALWAYS run after this; it is never overridable per-profile.
function disclosurePrefix(businessName: string): string {
  return `You've reached ${businessName}'s Ava AI assistant. This call is transcribed.`;
}

export interface InitBlob {
  sid: string;
  call_id: string;
  trace_id: string;
  owner_uid: string;         // callee — the business/account this agent answers for
  caller_uid: string;
  caller_name: string | null;
  caller_phone: string | null;
  billing_mode: "A" | "B";
  is_service_number: boolean;
  number_key: string;        // concurrency key (see lib/call_routing.ts concurrencyKeyFor) — released at finalize
  service_number: string | null;
  agent_profile_id: string;
  agent_profile_version: number;
  instructions: string | null;
  collection_id: string | null;
  tool_manifest: string | null; // raw JSON string (array of {name, description, parameters, kind, composio_slug})
  booking_authority: BookingAuthority;
  business_name: string | null;
  owner_name: string | null;
  snapshot: CallSnapshot;    // rate/fee snapshot frozen at call_created — settlement reads this, never live config
  rtc_token: string;
}

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  kind?: "create_booking" | "send_email" | "composio";
  composio_slug?: string;
}

const DEFAULT_TOOLS: ToolDef[] = [
  {
    name: "create_booking", kind: "create_booking",
    description: "Book an appointment/reservation for the caller once they've agreed to a specific date and time.",
    parameters: {
      type: "object",
      properties: {
        caller_name: { type: "string" }, caller_email: { type: "string" }, caller_phone: { type: "string" },
        date: { type: "string", description: "ISO date, e.g. 2026-07-20" },
        time: { type: "string", description: "24h time, e.g. 14:30" },
        service: { type: "string" }, notes: { type: "string" },
        confirmed: { type: "boolean", description: "Set true ONLY after the caller has verbally confirmed the read-back details." },
      },
      required: ["caller_name", "date", "time"],
    },
  },
  {
    name: "send_email", kind: "send_email",
    description: "Send a confirmation or informational email to the caller (or another address they provide).",
    parameters: {
      type: "object",
      properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["to", "subject", "body"],
    },
  },
];

export class AgentVoiceRoom {
  private state: DurableObjectState;
  private env: Env;

  private client: WebSocket | null = null;
  private grok: WebSocket | null = null;
  private init: InitBlob | null = null;
  private tools: ToolDef[] = DEFAULT_TOOLS;
  private startedAt = 0;
  private finalized = false;
  private firstResponseReceived = false;

  private minuteTimer: ReturnType<typeof setInterval> | null = null;
  private wrapUpTimer: ReturnType<typeof setTimeout> | null = null;
  private hardCapTimer: ReturnType<typeof setTimeout> | null = null;
  private minuteIndex = 0;
  private walletLowSent = false;

  private ownerEmail: string | null = null;
  private ownerPhone: string | null = null;

  private dialog: Array<{ who: "ava" | "caller"; text: string }> = [];
  private toolsUsed: string[] = [];
  private bookingCreated = false;
  private recBytes = 0;

  constructor(state: DurableObjectState, env: Env) {
    // MUST NOT throw even if GROK_API_KEY is unset — plan §4/§9 "deploy is
    // safe with no GROK_API_KEY set; fail at session start with
    // GROK_SESSION_FAIL + voicemail fallback", not at construction time.
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const url = new URL(req.url);
    const sid = url.searchParams.get("session") || "";
    const token = url.searchParams.get("t") || "";

    const raw = await this.env.TOKENS.get(`agent_rtc:${sid}`, "json").catch(() => null);
    const init = raw as InitBlob | null;
    if (!init || init.rtc_token !== token) return new Response("forbidden", { status: 403 });
    if (this.finalized) return new Response("gone", { status: 410 });
    this.init = init;
    this.startedAt = Date.now();
    this.env.TOKENS.delete(`agent_rtc:${sid}`).catch(() => {}); // single-use token
    this.tools = parseToolManifest(init.tool_manifest);

    try { const c = await contactFor(this.env, init.owner_uid); this.ownerEmail = c.email; this.ownerPhone = c.phone; } catch { /* best-effort */ }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.client = server;
    server.addEventListener("message", (ev) => this.onClientMessage(ev));
    server.addEventListener("close", () => void this.finalize("caller_hangup"));
    server.addEventListener("error", () => void this.finalize("error"));

    this.ev("agent_session_started", { provider: "grok", billing_mode: init.billing_mode, is_service_number: init.is_service_number });
    this.startGrokSession().catch((e) => {
      this.ev("agent_session_start_failed", { error: String(e).slice(0, 200) });
      void this.failSessionStart("start_exception");
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------------------
  private ev(event: string, props: Record<string, unknown> = {}): void {
    const i = this.init;
    if (!i) return;
    trackUserContact(this.env, i.owner_uid, this.ownerEmail, this.ownerPhone, event, "agent_voice",
      { ...props, call_id: i.call_id, caller_uid: i.caller_uid, agent_profile_id: i.agent_profile_id }, i.sid);
    emitCallEvent(this.env, {
      event, call_id: i.call_id, trace_id: i.trace_id || newTraceId(),
      caller_id: i.caller_uid, callee_id: i.owner_uid,
      call_mode: i.is_service_number ? "paid_ai" : "business",
      billing_mode: i.billing_mode,
      agent_profile_id: i.agent_profile_id, agent_profile_version: String(i.agent_profile_version),
      ts: Date.now(), event_schema_version: EVENT_SCHEMA_VERSION, props,
    }).catch(() => {});
  }

  // ---------------------------------------------------------------------
  // Session start — connect to Grok, send session.update, arm timers.
  // ---------------------------------------------------------------------
  private async startGrokSession(): Promise<void> {
    const init = this.init!;
    if (!this.env.GROK_API_KEY) {
      await this.failSessionStart("no_api_key");
      return;
    }

    let resp: Response;
    try {
      resp = await fetch(realtimeUrl(), {
        headers: { Upgrade: "websocket", Authorization: `Bearer ${this.env.GROK_API_KEY}` },
      });
    } catch (e) {
      this.ev("grok_connect_failed", { error: String(e).slice(0, 200) });
      await this.failSessionStart("connect_error");
      return;
    }
    const ws = (resp as unknown as { webSocket?: WebSocket }).webSocket;
    if (!ws) {
      this.ev("grok_connect_failed", { reason: "no_websocket_in_response" });
      await this.failSessionStart("no_websocket");
      return;
    }
    ws.accept();
    this.grok = ws;
    ws.addEventListener("message", (e) => void this.onGrokMessage(e));
    ws.addEventListener("close", () => {
      if (!this.firstResponseReceived) void this.failSessionStart("grok_closed_before_response");
      else void this.finalize("grok_closed");
    });
    ws.addEventListener("error", () => {
      if (!this.firstResponseReceived) void this.failSessionStart("grok_error_before_response");
    });

    const memories = await loadCallerMemory(this.env, init.owner_uid, init.caller_uid).catch(() => []);
    const businessName = init.business_name || init.owner_name || "our business";
    const memoryBlock = memories.length
      ? `\n\nWhat you remember about this caller from past calls:\n- ${memories.join("\n- ")}`
      : "";
    const instructions = [
      disclosurePrefix(businessName),
      (init.instructions || "").trim(),
      memoryBlock,
    ].filter(Boolean).join("\n\n");

    const grokTools: GrokTool[] = [];
    if (init.collection_id) {
      // Doc-confirmed shape (docs.x.ai "Using Tools with Grok Voice Agent
      // API" → Collections Search): {type:"file_search", vector_store_ids,
      // max_num_results}. The realtime doc explicitly documents file_search
      // for Collections-backed retrieval, so no server-side search_docs
      // fallback function tool is needed — Grok resolves this server-side.
      grokTools.push({ type: "file_search", vector_store_ids: [init.collection_id], max_num_results: 4 });
    }
    for (const t of this.tools) {
      grokTools.push({ type: "function", name: t.name, description: t.description, parameters: t.parameters });
    }
    // web_search / x_search are NEVER included (plan §4 owner decision) —
    // buildSessionUpdate also defensively strips them if somehow present.
    this.sendToGrok(buildSessionUpdate({ instructions, tools: grokTools }));
    this.ev("agent_session_config", {
      collection_id: init.collection_id, tool_count: grokTools.length,
      memory_loaded: memories.length > 0, memory_size: memories.length,
      instruction_version: String(init.agent_profile_version),
    });

    // Timers: T-30s wrap-up nudge, hard cap at agentMaxCallSec (plan §4/§9).
    const cfg = await readConfig(this.env);
    const capMs = Math.max(30, cfg.agentMaxCallSec) * 1000;
    this.wrapUpTimer = setTimeout(() => this.injectWrapUp("time_limit"), Math.max(1000, capMs - 30_000));
    this.hardCapTimer = setTimeout(() => void this.finalize("hard_cap"), capMs);
    // Per-minute settle ticker.
    this.minuteTimer = setInterval(() => void this.tickMinute(), MINUTE_MS);
  }

  /** GROK_SESSION_FAIL before the caller ever heard a response: refund per the
   *  §11 matrix (100% — nothing was delivered) and hand the caller a signal
   *  the client uses to fall back to voicemail, then close. */
  private async failSessionStart(stage: string): Promise<void> {
    if (this.finalized) return;
    const init = this.init;
    if (!init) { this.finalized = true; return; }
    this.ev("grok_session_fail", { stage });
    try {
      this.client?.send(JSON.stringify({ t: "agent_fail", reason: "GROK_SESSION_FAIL", fallback: "voicemail" }));
      this.client?.close(1011, "agent_unavailable");
    } catch { /* caller gone */ }
    await refundUnused(this.env, {
      call_id: init.call_id,
      caller_id: init.caller_uid, callee_id: init.owner_uid,
      caller_or_callee_id: init.billing_mode === "A" ? init.owner_uid : init.caller_uid,
      reason: "GROK_SESSION_FAIL", billing_mode: init.billing_mode, trace_id: init.trace_id,
    }).catch(() => {});
    await releaseAgentSlot(this.env, init.call_id).catch(() => {});
    this.finalized = true;
    this.clearTimers();
  }

  // ---------------------------------------------------------------------
  // Audio bridging.
  // ---------------------------------------------------------------------
  private onClientMessage(ev: MessageEvent): void {
    if (this.finalized) return;
    const d = ev.data as unknown;
    if (typeof d === "string") return; // no client control frames honored on the audio channel
    const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : null;
    if (!bytes || !bytes.byteLength) return;
    if (this.recBytes < MAX_REC_BYTES) this.recBytes += bytes.byteLength;
    // Caller PCM16 → Grok realtime input event. Session declared
    // input_audio_format:"pcm16" — sample-rate negotiation follows the same
    // client contract the other call-bot DOs use (PCM16 16k in); see the
    // wire-protocol caveat at the top of this file.
    this.sendToGrok({ type: "input_audio_buffer.append", audio: b64encode(bytes) });
  }

  private sendToGrok(obj: Record<string, unknown>): void {
    try { this.grok?.send(JSON.stringify(obj)); } catch { /* grok socket gone */ }
  }

  private async onGrokMessage(ev: MessageEvent): Promise<void> {
    if (this.finalized) return;
    let m: any;
    try {
      const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      m = JSON.parse(raw);
    } catch { return; }
    const type = String(m?.type || "");
    if (!type) return;

    // response.output_audio.delta — doc-confirmed name (docs.x.ai Voice Agent
    // API, both the audio-playback sample and the function-call-handling
    // sample use this exact event). `response.audio.delta` accepted too as a
    // defensive legacy fallback in case an older API version is pinned.
    if ((type === "response.output_audio.delta" || type === "response.audio.delta") && typeof m.delta === "string") {
      if (!this.firstResponseReceived) { this.firstResponseReceived = true; this.ev("agent_first_audio", { ms: Date.now() - this.startedAt }); }
      const pcm = b64decode(m.delta);
      try { this.client?.send(pcm); } catch { /* caller gone */ }
      return;
    }
    // response.output_audio_transcript.delta — same output-prefixed GA rename
    // family as response.output_audio.delta above. Not spelled out verbatim
    // in the fetched doc page, so the legacy name is also accepted.
    if ((type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") && typeof m.delta === "string") {
      this.pushDialog("ava", m.delta); return;
    }
    // conversation.item.input_audio_transcription.completed — doc-confirmed
    // to still exist (xAI only renames the incremental `.delta` variant to
    // `.updated`; `.completed` isn't in the "Unsupported Server Events" list).
    if (type === "conversation.item.input_audio_transcription.completed" && typeof m.transcript === "string") {
      this.pushDialog("caller", m.transcript); return;
    }
    // response.function_call_arguments.done — doc-confirmed exact event name
    // ("Function Call Events" table). response.output_item.done kept as a
    // defensive fallback only; not in the doc's event table.
    if (type === "response.function_call_arguments.done" || (type === "response.output_item.done" && m.item?.type === "function_call")) {
      const call = type === "response.output_item.done" ? m.item : m;
      const name = String(call?.name ?? "");
      const callId = String(call?.call_id ?? call?.id ?? "");
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(String(call?.arguments ?? "{}")); } catch { args = {}; }
      if (name && callId) await this.handleFunctionCall(name, callId, args);
      return;
    }
    if (type === "error") {
      this.ev("agent_grok_error", { error: JSON.stringify(m?.error ?? m).slice(0, 300) });
      return;
    }
    if (type === "session.updated" || type === "response.done" || type === "session.created" || type === "response.created") {
      // Doc-confirmed lifecycle events (session.updated echoes applied
      // config incl. `replace`; response.created/response.done bracket every
      // turn, including force_message turns). No action needed today —
      // logged for future diagnostics, never affects the audio bridge.
      return;
    }
  }

  private pushDialog(who: "ava" | "caller", text: string): void {
    const t = (text ?? "").toString();
    if (!t) return;
    const last = this.dialog[this.dialog.length - 1];
    if (last && last.who === who) last.text += t;
    else this.dialog.push({ who, text: t });
  }

  // ---------------------------------------------------------------------
  // Tool execution — booking_authority enforcement + Composio side effects.
  // ---------------------------------------------------------------------
  private async handleFunctionCall(name: string, callId: string, args: Record<string, unknown>): Promise<void> {
    const init = this.init!;
    this.toolsUsed.push(name);
    const timedOut = Symbol("timeout");
    let output: unknown;
    try {
      output = await Promise.race([
        withSpan(this.env, { call_id: init.call_id, trace_id: init.trace_id, caller_id: init.caller_uid, callee_id: init.owner_uid },
          `tool:${name}`, () => this.runTool(name, args)),
        new Promise((resolve) => setTimeout(() => resolve(timedOut), TOOL_CALL_TIMEOUT_MS)),
      ]);
    } catch (e) {
      output = { error: String(e).slice(0, 200) };
    }
    const ok = output !== timedOut;
    const reason: ReasonCode | undefined = ok ? undefined : "TOOL_TIMEOUT";
    this.ev("tool_called", { tool: name, ok, reason });
    const payload = ok ? output : { error: "tool_call_timed_out" };
    this.sendToGrok({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(payload) },
    });
    this.sendToGrok({ type: "response.create" });
  }

  private async runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const init = this.init!;
    const def = this.tools.find((t) => t.name === name);
    const kind = def?.kind ?? (name === "create_booking" ? "create_booking" : name === "send_email" ? "send_email" : "composio");

    if (kind === "create_booking") return this.runCreateBooking(args);
    if (kind === "send_email") {
      const to = String(args.to || ""), subject = String(args.subject || "(no subject)"), body = String(args.body || "");
      if (!to) return { error: "missing 'to'" };
      const r = await executeTool(this.env, init.owner_uid, "GMAIL_SEND_EMAIL", { recipient_email: to, subject, body });
      return { ok: !(r && (r.successful === false || r.error)), result: r };
    }
    // Generic Composio pass-through tool declared on the profile's tool_manifest.
    const slug = def?.composio_slug || name;
    const r = await executeTool(this.env, init.owner_uid, slug, args);
    return { ok: !(r && (r.successful === false || r.error)), result: r };
  }

  /** booking_authority (plan §12.8):
   *   auto_write            → commit immediately.
   *   confirm_with_caller   → (default) require the agent to have read the
   *                           details back and gotten a verbal yes FIRST —
   *                           enforced here by requiring args.confirmed===true;
   *                           the first call (confirmed missing/false) is
   *                           answered with instructions to read back + re-call.
   *   require_owner_approval→ write a PENDING record + notify the owner;
   *                           never commits from this call.
   */
  private async runCreateBooking(args: Record<string, unknown>): Promise<unknown> {
    const init = this.init!;
    const authority = init.booking_authority;

    if (authority === "require_owner_approval") {
      await this.writePendingBooking(args);
      try {
        await this.env.Q_PUSH.send({
          kind: "notify", to: init.owner_uid, fromName: "Ava",
          title: "Booking needs your approval",
          body: `A caller wants to book: ${bookingSummary(args)}`,
          data: { type: "agent_booking_pending", call_id: init.call_id },
        });
      } catch { /* best-effort */ }
      this.ev("booking_pending", { details: bookingSummary(args) });
      return { ok: true, status: "pending_owner_approval", message: "Your request has been sent to the owner for approval — they'll follow up with you." };
    }

    if (authority === "confirm_with_caller" && args.confirmed !== true) {
      return {
        ok: true, status: "needs_confirmation",
        message: `Read these details back to the caller EXACTLY and ask for a clear yes before proceeding: ${bookingSummary(args)}. Only call create_booking again with confirmed:true once they verbally agree.`,
      };
    }

    // auto_write, OR confirm_with_caller with confirmed:true → commit now.
    const r = await executeTool(this.env, init.owner_uid, "GOOGLECALENDAR_CREATE_EVENT", {
      summary: String(args.service || "Booking") + (args.caller_name ? ` — ${args.caller_name}` : ""),
      start_datetime: `${args.date || ""}T${args.time || "00:00"}:00`,
      description: [args.notes, args.caller_email, args.caller_phone].filter(Boolean).join(" | "),
    }).catch((e) => ({ error: String(e).slice(0, 200) }));
    const ok = !(r && (r as any).error);
    if (ok) {
      this.bookingCreated = true;
      this.ev("booking_created", { details: bookingSummary(args), authority });
      if (args.caller_email) {
        await executeTool(this.env, init.owner_uid, "GMAIL_SEND_EMAIL", {
          recipient_email: String(args.caller_email),
          subject: `Booking confirmed — ${init.business_name || init.owner_name || "AvaTOK"}`,
          body: `Hi ${args.caller_name || ""},\n\nYour booking is confirmed: ${bookingSummary(args)}.\n\nThanks!`,
        }).catch(() => {});
      }
    }
    return { ok, status: ok ? "booked" : "failed", message: ok ? `Booked: ${bookingSummary(args)}.` : "Sorry, I couldn't complete the booking just now." };
  }

  private async writePendingBooking(args: Record<string, unknown>): Promise<void> {
    const init = this.init!;
    try {
      await this.env.DB_META.prepare(
        `CREATE TABLE IF NOT EXISTS agent_pending_bookings (
           id TEXT PRIMARY KEY, call_id TEXT NOT NULL, owner_uid TEXT NOT NULL,
           caller_uid TEXT NOT NULL, details_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
           created_at INTEGER NOT NULL
         )`,
      ).run();
      await this.env.DB_META.prepare(
        `INSERT INTO agent_pending_bookings (id, call_id, owner_uid, caller_uid, details_json, status, created_at)
         VALUES (?1,?2,?3,?4,?5,'pending',?6)`,
      ).bind(crypto.randomUUID(), init.call_id, init.owner_uid, init.caller_uid, JSON.stringify(args), Date.now()).run();
    } catch { /* best-effort — the push notification is the primary signal */ }
  }

  // ---------------------------------------------------------------------
  // Billing.
  // ---------------------------------------------------------------------
  private async tickMinute(): Promise<void> {
    if (this.finalized) return;
    const init = this.init!;
    this.minuteIndex += 1;
    const r = await settleCallMinute(this.env, {
      call_id: init.call_id, caller_id: init.caller_uid, callee_id: init.owner_uid,
      minute_index: this.minuteIndex, snapshot: init.snapshot,
      is_service_number: init.is_service_number, billing_mode: init.billing_mode, trace_id: init.trace_id,
    }).catch(() => ({ ok: false, settled: 0 } as any));
    if (!r.ok || r.settled <= 0) {
      if (!this.walletLowSent) {
        this.walletLowSent = true;
        this.ev("agent_call_wallet_cutoff", { minute_index: this.minuteIndex, billing_mode: init.billing_mode });
        this.injectWrapUp("wallet_low");
        // Grace window for the agent to say goodbye, then hang up.
        setTimeout(() => void this.finalize("wallet_cutoff"), 15_000);
      }
    }
  }

  private injectWrapUp(reason: "time_limit" | "wallet_low"): void {
    if (this.finalized) return;
    this.sendToGrok(buildWrapUpNudge(reason));
    this.sendToGrok({ type: "response.create" });
    this.ev("agent_wrap_up_injected", { reason });
  }

  // ---------------------------------------------------------------------
  // Finalize — transcript to R2, agent_call_log row, callee InboxDO thread,
  // mem0 summary, call_aggregate.
  // ---------------------------------------------------------------------
  private clearTimers(): void {
    if (this.minuteTimer) clearInterval(this.minuteTimer);
    if (this.wrapUpTimer) clearTimeout(this.wrapUpTimer);
    if (this.hardCapTimer) clearTimeout(this.hardCapTimer);
    this.minuteTimer = null; this.wrapUpTimer = null; this.hardCapTimer = null;
  }

  private async finalize(reason: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.clearTimers();
    try { this.grok?.close(); } catch { /* ignore */ }
    try { this.client?.send(JSON.stringify({ t: "ended", reason })); this.client?.close(1000, reason); } catch { /* ignore */ }

    const init = this.init;
    if (!init) return;
    await releaseAgentSlot(this.env, init.call_id).catch(() => {});

    const now = Date.now();
    const durationS = Math.max(0, Math.round((now - this.startedAt) / 1000));
    const transcript = this.buildTranscript();
    const summaryText = transcript
      ? `Call with ${init.caller_name || "caller"} — ${durationS}s. ${this.bookingCreated ? "Booking created. " : ""}${this.toolsUsed.length ? `Tools used: ${[...new Set(this.toolsUsed)].join(", ")}.` : ""}`.trim()
      : `No conversation recorded (${reason}).`;

    let transcriptKey: string | null = null;
    try {
      transcriptKey = `agent_transcripts/${init.owner_uid}/${init.caller_uid}/${init.sid}.txt`;
      await this.env.BLOBS.put(transcriptKey, transcript || "(empty)", { httpMetadata: { contentType: "text/plain" } });
    } catch (e) { this.ev("agent_transcript_store_failed", { error: String(e).slice(0, 200) }); }

    try {
      // Defensive ensure — this table is normally created by
      // routes/agent_profiles.ts's ensureTables(), but that module may never
      // have been hit yet on a fresh isolate that only ever serves calls.
      await this.env.DB_META.prepare(
        `CREATE TABLE IF NOT EXISTS agent_call_log (
           call_id TEXT PRIMARY KEY, caller_id TEXT, owner_uid TEXT NOT NULL,
           service_number TEXT, transcript_r2 TEXT, summary TEXT, created_at INTEGER NOT NULL
         )`,
      ).run();
      await this.env.DB_META.prepare(
        `INSERT INTO agent_call_log (call_id, caller_id, owner_uid, service_number, transcript_r2, summary, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(call_id) DO UPDATE SET transcript_r2=?5, summary=?6`,
      ).bind(init.call_id, init.caller_uid, init.owner_uid, init.service_number, transcriptKey, summaryText, now).run();
    } catch (e) { this.ev("agent_call_log_write_failed", { error: String(e).slice(0, 200) }); }

    // Callee-side InboxDO thread (plan §6 — caller sees NOTHING; this is
    // callee-only, same delivery mechanism voicemail/receptionist use).
    try {
      const callerLabel = init.caller_name || init.caller_phone || "Unknown caller";
      const conv = `agent_${init.owner_uid}__${init.caller_uid}`;
      const bodyText = `🤖 Ava AI Agent call with ${callerLabel}: ${summaryText}`;
      const envelope = JSON.stringify({
        t: "agent_transcript", text: bodyText, session_id: init.sid,
        caller_uid: init.caller_uid, caller_name: init.caller_name, caller_phone: init.caller_phone,
        call_id: init.call_id, duration_s: durationS, transcript, booking_created: this.bookingCreated,
        tools_used: [...new Set(this.toolsUsed)],
      });
      const stub = this.env.INBOX.get(this.env.INBOX.idFromName(init.owner_uid));
      await stub.fetch("https://inbox/append", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conv, sender: init.caller_uid || "ava_system", kind: "agent_transcript", body: envelope,
          media_ref: transcriptKey, scope: `to:${init.owner_uid}`, created_at: now,
          owner: init.owner_uid, client_id: `agent:${init.sid}`,
        }),
      });
      try {
        await this.env.Q_PUSH.send({
          kind: "notify", to: init.owner_uid, fromName: "Ava",
          title: this.bookingCreated ? "Ava booked a call" : "Ava took a call",
          body: summaryText.slice(0, 140), data: { type: "agent_transcript", conv, caller_uid: init.caller_uid },
        });
      } catch { /* best-effort */ }
    } catch (e) { this.ev("agent_thread_post_failed", { error: String(e).slice(0, 200) }); }

    // mem0 caller summary (best-effort, never blocks finalize).
    await writeCallSummary(this.env, init.owner_uid, init.caller_uid, summaryText).catch(() => {});

    // Round UP the final partial minute (plan §11, owner decision 2026-07-11
    // — supersedes the earlier round-down rule: "a started minute counts as a
    // whole minute"). `minuteIndex` only reflects minutes the 60s tickMinute()
    // ticker has already settled; if real time elapsed into the NEXT minute
    // (tickMinute never got to fire before finalize), settle that one minute
    // as a full minute here, THEN refund the remainder below. Idempotent on
    // the same `settle:call:<id>:m<n>` opId tickMinute uses, so a race with a
    // just-fired tick can never double-charge. Guard against over-settling:
    // Mode A is hard-capped at agentMaxCallSec/60 minutes (hardCapTimer fires
    // finalize() at the cap, so this can add at most the one minute still
    // inside the cap); settleCallMinute itself also refuses to settle past
    // whatever's left in the call's escrow (see call_billing.ts), so neither
    // mode can ever settle more than was actually held.
    const elapsedMs = Date.now() - this.startedAt;
    if (elapsedMs > this.minuteIndex * MINUTE_MS) {
      const partialIndex = this.minuteIndex + 1;
      const cfg = await readConfig(this.env).catch(() => null);
      const capMinutes = init.billing_mode === "A" && cfg ? cfg.agentMaxCallSec / 60 : Infinity;
      if (partialIndex <= capMinutes) {
        try {
          const r = await settleCallMinute(this.env, {
            call_id: init.call_id, caller_id: init.caller_uid, callee_id: init.owner_uid,
            minute_index: partialIndex, snapshot: init.snapshot,
            is_service_number: init.is_service_number, billing_mode: init.billing_mode, trace_id: init.trace_id,
          });
          if (r.ok && r.settled > 0) this.minuteIndex = partialIndex;
        } catch { /* best-effort — an unsettled partial minute just refunds instead below */ }
      }
    }

    // Refund whatever's left in escrow (plan §11/§15.3 — one money path for
    // every call type). CALL_ENDED = a normal end (hangup / wrap-up / hard
    // cap), not a Grok failure — GROK_SESSION_FAIL is used exclusively by
    // failSessionStart() above, before any of these code paths run.
    const refundReason: ReasonCode = "CALL_ENDED";
    await refundUnused(this.env, {
      call_id: init.call_id, caller_id: init.caller_uid, callee_id: init.owner_uid,
      caller_or_callee_id: init.billing_mode === "A" ? init.owner_uid : init.caller_uid,
      reason: refundReason, billing_mode: init.billing_mode, trace_id: init.trace_id,
    }).catch(() => {});

    this.ev("call_ended", { reason, duration_s: durationS, minutes_billed: this.minuteIndex });
    // call_aggregate — the canonical roll-up (plan §14). Best-effort; a
    // dashboard consumer treats a missing/partial field as "unknown", never
    // a hard failure.
    this.ev("call_aggregate", {
      call_id: init.call_id, trace_id: init.trace_id, human_or_ai: "ai",
      friend_or_business: init.is_service_number ? "business" : "business",
      duration: durationS, resolved: this.dialog.length > 0,
      booking: this.bookingCreated, agent_profile_version: init.agent_profile_version,
      event_schema_version: EVENT_SCHEMA_VERSION, cutoff_reason: reason,
      tools_used: [...new Set(this.toolsUsed)], minutes_billed: this.minuteIndex,
    });
  }

  private buildTranscript(): string {
    const avaName = "Ava";
    const callerName = this.init?.caller_name || "Caller";
    return this.dialog.map((d) => `${d.who === "ava" ? avaName : callerName}: ${d.text}`).join("\n");
  }
}

// ── helpers ──────────────────────────────────────────────────────────────
function parseToolManifest(raw: string | null): ToolDef[] {
  if (!raw) return DEFAULT_TOOLS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_TOOLS;
    const out: ToolDef[] = parsed
      .filter((t) => t && typeof t === "object" && typeof t.name === "string")
      .map((t) => ({
        name: String(t.name), description: String(t.description || `Call ${t.name}`),
        parameters: (t.parameters && typeof t.parameters === "object") ? t.parameters : { type: "object", properties: {} },
        kind: t.kind === "create_booking" || t.kind === "send_email" || t.kind === "composio" ? t.kind : undefined,
        composio_slug: typeof t.composio_slug === "string" ? t.composio_slug : undefined,
      }));
    // Always guarantee create_booking + send_email exist even if the manifest
    // only customises/extends beyond them (plan: "custom function tools from
    // profile.tool_manifest (create_booking, send_email)").
    const names = new Set(out.map((t) => t.name));
    for (const d of DEFAULT_TOOLS) if (!names.has(d.name)) out.push(d);
    return out.length ? out : DEFAULT_TOOLS;
  } catch { return DEFAULT_TOOLS; }
}

function bookingSummary(args: Record<string, unknown>): string {
  const parts = [args.service, args.date, args.time, args.caller_name].filter(Boolean);
  return parts.length ? parts.join(", ") : "a booking";
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
