// [AUMFE-VOICE-RUNTIME-1 2026-10-01] VoiceSessionDO — one voice-guide call.
// Relays the customer's browser WebSocket to Gemini Live (Developer API, BidiGenerateContent) so that the key, the
// persona prompt, the tools, the time cap and the meter all stay server-side. NOT hibernated: a call is short and holds
// a live outbound socket (same shape as do/reception_room.ts, whose Gemini Live patterns this reuses).
//
//   browser  <-- WS: binary PCM16 16 kHz in / PCM16 24 kHz out, JSON ClientMsg / ServerMsg -->  this DO
//   this DO  <-- WS: Gemini Live realtimeInput / serverContent / toolCall / toolResponse   -->  Gemini
//
// Wire protocol + agent/tool contract: lib/voice_agents/types.ts. Pure logic (translation, captions, cost, gate):
// lib/voice_agents/session_logic.ts. Spec: Specs/SPEC-2026-10-01-VOICE-AGENTS.md.
// Captions carry the CUMULATIVE text of the current turn per speaker (replace, don't append); final=true closes it.
//
// ⚠️ Gemini Live frame shapes follow the receptionist's proven setup/realtimeInput/toolResponse usage. Verify on the
// first live call: the 3.8 model id, `behavior: NON_BLOCKING` + `scheduling` support (we retry once without them if the
// socket closes before setupComplete), `sessionResumption`/`goAway`, and `realtimeInput.video` for image messages.
import type { Env } from "../types";
import type { ClientMsg, ServerMsg, VoiceAgentDef, VoiceCard, VoiceTool, VoiceToolCtx } from "../lib/voice_agents/types";
import { trackUserContact, trackException } from "../hooks";
import { readConfig, type PlatformConfig } from "../routes/config";
import { BRAND } from "../lib/brand";
import { getAgent, toPublic } from "../lib/voice_agents/registry";
import { memoryTools } from "../lib/voice_agents/memory_tools";
import { startSession, endSession, buildBriefing, listMemories } from "../lib/agent_memory";
import {
  CaptionTracker, buildTranscript, b64decode, b64encode, capToolResult, emptyUsage, liveCostUsd, meterCostPaise,
  nowIstString, parseUsage, rememberLines, scrubSecrets, translateGemini, type GemEvent, type GemToolCall, type LiveUsage,
} from "../lib/voice_agents/session_logic";
import {
  applyCharge, balanceEndS, chargedPaise, cleanFreeSeconds, closeBilling, newBilling, nextChargeDue, priceTokensPerMin,
  remainingSeconds, runwayHoldTokens, runwayTopUpTokens, type BillingState,
} from "../lib/voice_agents/billing";
import { chargeMinute, holdRunway, readSpendable, releaseHold, resolvePayer } from "../lib/voice_agents/billing_wallet";

const APP = "aumfe_voice";
const GEMINI_WS = "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";
const HDR_UID = "x-voice-uid";
const HDR_AGENT = "x-voice-agent";
const HDR_EMAIL = "x-voice-email";

const IDLE_MS = 120_000;            // no frame/message from the browser for this long -> end (idle)
const SETUP_TIMEOUT_MS = 20_000;    // Gemini must answer setup within this
const ENDING_SOON_S = 60;
const METER_EVERY_S = 5;
const TOOL_TIMEOUT_MS = 20_000;
const MAX_AUDIO_FRAME = 64 * 1024;  // PCM16 16 kHz: ~2 s; real frames are 20-100 ms
const MAX_TEXT_CHARS = 1000;
const MAX_IMAGE_B64 = 700_000;
const MAX_RECONNECTS = 2;
const CHARGE_RETRY_GIVE_UP_S = 20;  // [AUMFE-VOICE-BILLING-1] a wallet that keeps erroring must not give free minutes forever
const HOLD_SLACK_MS = 300_000;      // wallet-side expiry of the runway hold = call cap + this (safety net if the DO dies)

type EndReason = "customer" | "time_up" | "balance_out" | "error" | "idle" | "server";
type AgentState = "connecting" | "listening" | "thinking" | "speaking";

export class VoiceSessionDO {
  private state: DurableObjectState;
  private env: Env;

  private client: WebSocket | null = null;
  private gem: WebSocket | null = null;
  private downHandled = new WeakSet<WebSocket>();

  private uid = "";
  private email: string | null = null;
  private agent!: VoiceAgentDef;
  private cfg!: PlatformConfig;
  private model = "";
  private sessionId = "";
  private tools = new Map<string, VoiceTool>();
  private setupSystem = "";

  private openedAt = Date.now();
  private callStartedAt = 0;           // set when the greeting goes out (both sides ready) — the meter's zero
  private lastActivityAt = Date.now();
  private tick: ReturnType<typeof setInterval> | null = null;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMeterS = -METER_EVERY_S;
  private endingSoonSent = false;

  // [AUMFE-VOICE-BILLING-1] paid-call billing. bill === null means unpriced (price 0) -> "test" billing, nothing charged.
  private bill: BillingState | null = null;
  private payer = "";
  private held = 0;                                    // tokens in the runway hold
  private reserveP: Promise<void> | null = null;      // resolves when the start-of-call hold attempt is settled
  private chargeP: Promise<void> | null = null;       // a minute charge is in flight
  private chargeFailSinceS = -1;

  private finished = false;
  private begun = false;
  private setupDone = false;
  private clientStarted = false;
  private greeted = false;
  private muted = false;
  private plainTools = false;          // retry flag: setup without behavior/scheduling
  private triedPlain = false;
  private reconnecting = false;
  private reconnects = 0;
  private resumeHandle = "";
  private agentState: AgentState = "connecting";

  private captions = new CaptionTracker();
  private toolCalls = 0;
  private cancelledToolIds = new Set<string>();
  private firstAudioAt = 0;
  private inBytes = 0;
  private outBytes = 0;
  private usage: LiveUsage = emptyUsage();
  private turns = 0;
  private lastGemClose: { code: number | null; reason: string | null } | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // -------------------------------------------------------------------------
  // Entry: the worker route forwards the upgrade with trusted headers.
  // -------------------------------------------------------------------------
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("websocket required", { status: 426 });
    if (this.client || this.begun) return new Response("session already open", { status: 409 });
    const uid = req.headers.get(HDR_UID) || "";
    const agent = getAgent(req.headers.get(HDR_AGENT));
    if (!uid || !agent) return new Response("bad session", { status: 400 });
    if (!this.env.GEMINI_API_KEY) return new Response("voice unavailable", { status: 503 });
    this.begun = true;
    this.uid = uid;
    this.agent = agent;
    const em = req.headers.get(HDR_EMAIL);
    this.email = em ? decodeURIComponent(em) : null;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.client = server;
    server.addEventListener("message", (ev) => { void this.onClientMessage(ev); });
    server.addEventListener("close", () => { void this.finish("customer"); });
    server.addEventListener("error", (ev: any) => {
      void trackException(this.env, ev?.error ?? new Error("client websocket error"), { uid, route: "VoiceSessionDO.client", handled: true, app_name: APP });
      void this.finish("customer");
    });

    this.state.waitUntil(this.begin().catch((e) => this.failWith("start_failed", "Could not start the call.", e)));
    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------
  // Session start
  // -------------------------------------------------------------------------
  private async begin(): Promise<void> {
    this.cfg = await readConfig(this.env);
    this.model = (this.cfg.voiceAgentModel || "gemini-3.8-live").trim();
    this.sessionId = await startSession(this.env, this.uid, this.agent.id, "voice");

    let briefing = "";
    try { briefing = await buildBriefing(this.env, this.uid, this.agent.id); } catch (e) {
      void trackException(this.env, e, { uid: this.uid, route: "VoiceSessionDO.briefing", handled: true, app_name: APP });
    }
    let remembers: string[] = [];
    try {
      remembers = rememberLines((await listMemories(this.env, this.uid, { kind: "fact", limit: 3 })).map((m) => m.text));
    } catch (e) {
      void trackException(this.env, e, { uid: this.uid, route: "VoiceSessionDO.memories", handled: true, app_name: APP });
    }
    if (this.finished) return; // browser left while we were loading

    // [AUMFE-VOICE-BILLING-1] paid call: resolve the payer, check the wallet, hold the runway. Before `ready`, so a
    // customer without funds never hears a greeting. persist() awaits reserveP so a hold is always released.
    const priceTokens = priceTokensPerMin(this.cfg.voiceAgentPricePerMinPaise);
    if (priceTokens > 0) {
      let fail: { code: string; message: string } | null = null;
      this.reserveP = this.openBilling(priceTokens).then((f) => { fail = f; });
      await this.reserveP;
      if (fail) {
        const f = fail as { code: string; message: string };
        if (f.code === "insufficient_balance") { this.sendClient({ type: "error", code: f.code, message: f.message }); await this.finish("error"); } // expected, not an exception
        else await this.failWith(f.code, f.message, new Error(`voice billing start: ${f.code}`));
        return;
      }
      if (this.finished) return;
    }
    const freeS = cleanFreeSeconds(this.cfg.voiceAgentFreeSeconds);

    this.tools = new Map();
    for (const t of [...this.agent.tools, ...memoryTools]) if (!this.tools.has(t.decl.name)) this.tools.set(t.decl.name, t);
    this.setupSystem = this.agent.systemPrompt({ briefing, brandName: BRAND.name, nowIst: nowIstString() });

    this.sendClient({
      type: "ready", session_id: this.sessionId, agent: toPublic(this.agent), remembers,
      max_seconds: this.cfg.voiceAgentMaxSeconds, free_seconds: freeS,
      price_per_min_paise: this.cfg.voiceAgentPricePerMinPaise, billing: this.bill ? "live" : "test",
    });
    this.setAgentState("connecting");
    this.ev("voice_session_started", { agent: this.agent.id, model: this.model, has_briefing: !!briefing, remembers: remembers.length });

    this.tick = setInterval(() => { void this.onTick(); }, 1000);
    this.setupTimer = setTimeout(() => {
      if (!this.setupDone && !this.finished) void this.failWith("setup_timeout", "The guide could not connect. Please try again.", new Error("gemini setup timeout"));
    }, SETUP_TIMEOUT_MS);
    await this.connectGemini("");
  }

  // -------------------------------------------------------------------------
  // [AUMFE-VOICE-BILLING-1] Billing
  // -------------------------------------------------------------------------
  /** Read the wallet and take the runway hold. Returns a failure to show the customer, or null when the call may start. */
  private async openBilling(priceTokens: number): Promise<{ code: string; message: string } | null> {
    this.payer = await resolvePayer(this.env, this.uid);
    const spendable = await readSpendable(this.env, this.payer);
    if (spendable === null) return { code: "wallet_unavailable", message: "Could not check your wallet. Please try again." };
    if (spendable < priceTokens) return { code: "insufficient_balance", message: `You need at least \u20B9${priceTokens} in your wallet to talk to ${this.agent.name}.` };
    const hold = runwayHoldTokens(spendable, priceTokens);
    const expires = Date.now() + this.cfg.voiceAgentMaxSeconds * 1000 + HOLD_SLACK_MS;
    const r = await holdRunway(this.env, this.payer, this.sessionId, hold, hold, expires);
    if (!r.ok) {
      return r.reason === "insufficient"
        ? { code: "insufficient_balance", message: `You need at least \u20B9${priceTokens} in your wallet to talk to ${this.agent.name}.` }
        : { code: "wallet_unavailable", message: "Could not check your wallet. Please try again." };
    }
    this.held = hold;
    this.bill = newBilling(priceTokens, this.cfg.voiceAgentFreeSeconds, spendable);
    return null;
  }

  /** Charge every started minute that is due at `elapsedS`, one at a time (op id voice:<sid>:m<N> makes a replay harmless). */
  private async chargeDue(elapsedS: number): Promise<"ok" | "insufficient" | "error"> {
    for (;;) {
      const b = this.bill;
      if (!b) return "ok";
      const n = nextChargeDue(b, elapsedS);
      if (n === null) return "ok";
      const r = await chargeMinute(this.env, this.payer, this.sessionId, n, b.priceTokens, this.agent.name, b.priceTokens);
      this.ev("voice_charge", { uid: this.uid, session_id: this.sessionId, minute: n, tokens: b.priceTokens, ok: r.ok, ...(r.ok ? {} : { reason: r.reason }) });
      if (!r.ok) return r.reason;
      const spendable = (await readSpendable(this.env, this.payer)) ?? Math.max(0, b.spendable - b.priceTokens);
      this.bill = applyCharge(this.bill!, n, spendable);
      // Keep the hold at min(spendable, 5 min). The hold is not consumed by the charge, so this rarely adds anything.
      const topUp = runwayTopUpTokens(this.held, spendable, b.priceTokens);
      if (topUp > 0 && !this.finished) {
        const h = await holdRunway(this.env, this.payer, this.sessionId, topUp, this.held + topUp, Date.now() + this.cfg.voiceAgentMaxSeconds * 1000 + HOLD_SLACK_MS);
        if (h.ok) this.held += topUp;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Gemini Live connection
  // -------------------------------------------------------------------------
  private buildSetup(handle: string): Record<string, unknown> {
    const decls = Array.from(this.tools.values()).map((t) => (
      !this.plainTools && t.blocking !== true ? { ...t.decl, behavior: "NON_BLOCKING" } : { ...t.decl }
    ));
    return {
      setup: {
        model: `models/${this.model}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.agent.voice } } },
          // [AUMFE-VOICE-FIX-1] No thinkingConfig: gemini-3.8-live rejects it (1007 "Thinking level is not supported").
        },
        systemInstruction: { parts: [{ text: this.setupSystem }] },
        tools: [{ functionDeclarations: decls }],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: handle ? { handle } : {},
      },
    };
  }

  private async connectGemini(handle: string): Promise<void> {
    const key = this.env.GEMINI_API_KEY!;
    // Workers open an outbound WebSocket via fetch() with Upgrade: websocket on an https:// URL (wss:// throws).
    const resp = await fetch(`${GEMINI_WS}?key=${encodeURIComponent(key)}`, { headers: { Upgrade: "websocket" } });
    const gem = (resp as any).webSocket as WebSocket | undefined;
    if (!gem) throw new Error(`no upstream websocket (status ${resp.status})`);
    gem.accept();
    const old = this.gem;
    this.gem = gem;
    this.setupDone = false;
    gem.addEventListener("message", (ev) => { if (gem === this.gem) this.onGeminiMessage(ev); });
    gem.addEventListener("close", (ev: any) => {
      this.lastGemClose = {
        code: typeof ev?.code === "number" ? ev.code : null,
        reason: typeof ev?.reason === "string" ? scrubSecrets(ev.reason).slice(0, 300) : null,
      };
      void this.onGemDown(gem);
    });
    gem.addEventListener("error", (ev: any) => {
      this.lastGemClose = { code: null, reason: scrubSecrets(String(ev?.error ?? ev?.message ?? "error")).slice(0, 300) };
      void this.onGemDown(gem);
    });
    this.sendGem(this.buildSetup(handle));
    if (old && old !== gem) this.closeSocket(old, 1000, "replaced");
  }

  /** The upstream socket closed or errored (deduped per socket). */
  private async onGemDown(gem: WebSocket): Promise<void> {
    if (this.downHandled.has(gem)) return;
    this.downHandled.add(gem);
    if (gem !== this.gem || this.finished) return; // a replaced or already-finished socket
    this.ev("voice_gemini_closed", { ...(this.lastGemClose ?? {}), turns: this.turns, setup_done: this.setupDone, ms: Date.now() - this.openedAt });
    if (!this.setupDone) {
      // Closed before setupComplete: most likely the setup was rejected. Retry once without NON_BLOCKING/scheduling.
      if (!this.plainTools && !this.triedPlain) {
        this.plainTools = true; this.triedPlain = true;
        this.ev("voice_setup_retry_plain", {});
        try { await this.connectGemini(this.resumeHandle); } catch (e) { await this.failWith("gemini_connect", "The guide could not connect.", e); }
        return;
      }
      await this.failWith("gemini_closed", "The guide could not connect. Please try again.", new Error(`gemini closed before setup: ${JSON.stringify(this.lastGemClose)}`));
      return;
    }
    if (this.resumeHandle && this.reconnects < MAX_RECONNECTS) { await this.reconnect("closed"); return; }
    await this.finish(this.turns === 0 ? "error" : "server");
  }

  /** goAway / unexpected close mid-call: resume the same Gemini session on a fresh socket if we hold a handle. */
  private async reconnect(why: string): Promise<void> {
    if (this.finished || this.reconnecting) return;
    if (!this.resumeHandle || this.reconnects >= MAX_RECONNECTS) { await this.finish("server"); return; }
    this.reconnecting = true;
    this.reconnects++;
    this.ev("voice_gemini_reconnect", { why, attempt: this.reconnects });
    try {
      await this.connectGemini(this.resumeHandle);
    } catch (e) {
      void trackException(this.env, e, { uid: this.uid, route: "VoiceSessionDO.reconnect", handled: true, app_name: APP });
      this.reconnecting = false;
      await this.finish("server");
      return;
    }
    this.reconnecting = false;
  }

  private sendGem(obj: unknown): void {
    // A failed send means the upstream socket is gone; its close/error listener ends or resumes the call.
    try { this.gem?.send(JSON.stringify(obj)); } catch { /* upstream gone — handled by onGemDown */ }
  }

  // -------------------------------------------------------------------------
  // Gemini -> browser
  // -------------------------------------------------------------------------
  private onGeminiMessage(ev: MessageEvent): void {
    if (this.finished) return;
    let msg: unknown;
    try {
      msg = typeof ev.data === "string" ? JSON.parse(ev.data) : JSON.parse(new TextDecoder().decode(ev.data as ArrayBuffer));
    } catch (e) {
      void trackException(this.env, e, { uid: this.uid, route: "VoiceSessionDO.gemini_parse", handled: true, app_name: APP });
      return;
    }
    for (const e of translateGemini(msg)) {
      try { this.onGemEvent(e); } catch (err) { void this.failWith("internal", "Something went wrong with the call.", err); return; }
    }
  }

  private onGemEvent(e: GemEvent): void {
    switch (e.kind) {
      case "setup_complete":
        this.setupDone = true;
        if (this.setupTimer) { clearTimeout(this.setupTimer); this.setupTimer = null; }
        this.setAgentState("listening");
        this.maybeGreet();
        break;
      case "audio": {
        const pcm = b64decode(e.b64);
        this.outBytes += pcm.byteLength;
        if (!this.firstAudioAt) {
          this.firstAudioAt = Date.now();
          this.ev("voice_first_audio_ms", {
            agent: this.agent.id, ms: this.firstAudioAt - (this.callStartedAt || this.openedAt), since_open_ms: this.firstAudioAt - this.openedAt,
          });
        }
        this.setAgentState("speaking");
        this.sendAudio(pcm);
        break;
      }
      case "input_text":
        for (const m of this.captions.addInput(e.text)) this.sendClient(m);
        break;
      case "output_text":
        for (const m of this.captions.addOutput(e.text)) this.sendClient(m);
        break;
      case "interrupted":
        for (const m of this.captions.closeAgentTurn()) this.sendClient(m);
        this.sendClient({ type: "interrupted" });
        this.setAgentState("listening");
        break;
      case "turn_complete":
        this.turns++;
        for (const m of this.captions.closeAll()) this.sendClient(m);
        this.setAgentState("listening");
        break;
      case "tool_calls":
        void this.handleToolCalls(e.calls);
        break;
      case "tool_cancel":
        for (const id of e.ids) this.cancelledToolIds.add(id);
        break;
      case "go_away":
        this.ev("voice_gemini_go_away", { time_left_ms: e.timeLeftMs });
        void this.reconnect("go_away");
        break;
      case "resume_handle":
        this.resumeHandle = e.handle;
        break;
      case "usage":
        this.usage = parseUsage(e.usage);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------
  private async handleToolCalls(calls: GemToolCall[]): Promise<void> {
    if (calls.some((c) => this.tools.get(c.name)?.blocking === true)) this.setAgentState("thinking");
    const responses = await Promise.all(calls.map((c) => this.runOneTool(c)));
    if (this.finished) return;
    const live = responses.filter((r) => !this.cancelledToolIds.has(String(r.id)));
    if (live.length) this.sendGem({ toolResponse: { functionResponses: live } });
  }

  private async runOneTool(c: GemToolCall): Promise<{ id: string; name: string; response: Record<string, unknown>; scheduling?: string }> {
    const tool = this.tools.get(c.name);
    const nonBlocking = !!tool && tool.blocking !== true && !this.plainTools;
    const scheduling = nonBlocking ? (c.name === "remember" ? "SILENT" : "WHEN_IDLE") : undefined;
    const done = (output: unknown) => ({ id: c.id, name: c.name, response: { output }, ...(scheduling ? { scheduling } : {}) });
    this.toolCalls++;
    this.sendClient({ type: "tool", name: c.name, status: "start" });
    const t0 = Date.now();
    if (!tool) {
      this.sendClient({ type: "tool", name: c.name, status: "error" });
      this.ev("voice_tool_call", { tool: c.name, ms: 0, ok: false, agent: this.agent.id, reason: "unknown_tool" });
      return done({ error: "unknown_tool" });
    }
    let card: VoiceCard | undefined;
    const ctx: VoiceToolCtx = {
      env: this.env, uid: this.uid, sessionId: this.sessionId, agentId: this.agent.id, // uid is the verified caller, never a model arg
      showCard: (cd) => { card = cd; },
    };
    let result: unknown;
    try {
      result = await Promise.race([
        tool.run(ctx, c.args),
        new Promise<unknown>((resolve) => setTimeout(() => resolve({ error: "tool_timeout" }), TOOL_TIMEOUT_MS)),
      ]);
    } catch (e) {
      void trackException(this.env, e, { uid: this.uid, route: `VoiceSessionDO.tool.${c.name}`, handled: true, app_name: APP });
      result = { error: "tool_failed" };
    }
    const ok = !(result && typeof result === "object" && "error" in (result as Record<string, unknown>));
    this.sendClient({ type: "tool", name: c.name, status: ok ? "done" : "error", ...(card ? { card } : {}) });
    this.ev("voice_tool_call", { tool: c.name, ms: Date.now() - t0, ok, agent: this.agent.id });
    return done(capToolResult(result));
  }

  // -------------------------------------------------------------------------
  // Browser -> Gemini
  // -------------------------------------------------------------------------
  private async onClientMessage(ev: MessageEvent): Promise<void> {
    if (this.finished) return;
    try {
      this.lastActivityAt = Date.now();
      if (typeof ev.data !== "string") {
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        if (!bytes.byteLength || bytes.byteLength > MAX_AUDIO_FRAME) return;
        if (this.muted || !this.setupDone || !this.gem) return; // muted frames still count as activity above
        this.inBytes += bytes.byteLength;
        this.sendGem({ realtimeInput: { audio: { data: b64encode(bytes), mimeType: "audio/pcm;rate=16000" } } });
        return;
      }
      let m: ClientMsg;
      try { m = JSON.parse(ev.data) as ClientMsg; } catch {
        this.sendClient({ type: "error", code: "bad_message", message: "Unreadable message." });
        return;
      }
      switch (m?.type) {
        case "start": this.clientStarted = true; this.maybeGreet(); break;
        case "mute": this.muted = m.on === true; break;
        case "text": {
          const t = typeof m.text === "string" ? m.text.trim().slice(0, MAX_TEXT_CHARS) : "";
          if (t && this.setupDone) this.sendGem({ clientContent: { turns: [{ role: "user", parts: [{ text: t }] }], turnComplete: true } });
          break;
        }
        case "image": {
          const okMime = m.mime === "image/jpeg" || m.mime === "image/png";
          if (okMime && typeof m.data_b64 === "string" && m.data_b64.length > 0 && m.data_b64.length <= MAX_IMAGE_B64 && this.setupDone) {
            this.sendGem({ realtimeInput: { video: { data: m.data_b64, mimeType: m.mime } } });
          } else {
            this.sendClient({ type: "error", code: "bad_image", message: "That image could not be used." });
          }
          break;
        }
        case "end": await this.finish("customer"); break;
        default: this.sendClient({ type: "error", code: "bad_message", message: "Unknown message type." });
      }
    } catch (e) {
      await this.failWith("internal", "Something went wrong with the call.", e);
    }
  }

  /** The call clock starts when Gemini is ready AND the browser says the mic is ready. */
  private maybeGreet(): void {
    if (this.greeted || !this.setupDone || !this.clientStarted || this.finished) return;
    this.greeted = true;
    this.callStartedAt = Date.now();
    this.lastActivityAt = this.callStartedAt;
    this.sendGem({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "[The customer has just connected. Greet them now in your persona, briefly, then stop and listen.]" }] }],
        turnComplete: true,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Clock: meter, ending_soon, hard cap, idle
  // -------------------------------------------------------------------------
  private async onTick(): Promise<void> {
    if (this.finished) return;
    const now = Date.now();
    if (now - this.lastActivityAt > IDLE_MS) { await this.finish("idle"); return; }
    if (!this.callStartedAt) return;
    const elapsed = Math.floor((now - this.callStartedAt) / 1000);
    const max = this.cfg.voiceAgentMaxSeconds;

    // [AUMFE-VOICE-BILLING-1] charge started minutes. Capped at max-1: the instant the cap is reached the call is over,
    // so it must not open (and bill) a further minute.
    const b0 = this.bill;
    if (b0 && !this.chargeP && nextChargeDue(b0, Math.min(elapsed, Math.max(0, max - 1))) !== null) {
      const p = this.chargeDue(Math.min(elapsed, Math.max(0, max - 1)));
      this.chargeP = p.then(() => undefined, () => undefined);
      let out: "ok" | "insufficient" | "error" = "error";
      try { out = await p; } catch (e) {
        void trackException(this.env, e, { uid: this.uid, route: "VoiceSessionDO.charge", handled: true, app_name: APP, extra: { session_id: this.sessionId } });
      }
      this.chargeP = null;
      if (this.finished) return;
      if (out === "insufficient") { await this.finish("balance_out"); return; }
      if (out === "error") {
        if (this.chargeFailSinceS < 0) this.chargeFailSinceS = elapsed;
        if (elapsed - this.chargeFailSinceS >= CHARGE_RETRY_GIVE_UP_S) { await this.finish("error"); return; }
      } else this.chargeFailSinceS = -1;
    }

    const bill = this.bill;
    const balEnd = bill ? balanceEndS(bill) : Infinity;
    const remaining = remainingSeconds(elapsed, max, balEnd);
    if (elapsed - this.lastMeterS >= METER_EVERY_S) {
      this.lastMeterS = elapsed;
      this.sendClient({
        type: "meter", seconds: elapsed,
        cost_paise: bill ? chargedPaise(bill) : meterCostPaise(elapsed, this.cfg.voiceAgentFreeSeconds, this.cfg.voiceAgentPricePerMinPaise),
        remaining_seconds: remaining,
      });
    }
    if (!this.endingSoonSent && Math.min(max, balEnd) > ENDING_SOON_S && remaining <= ENDING_SOON_S) {
      this.endingSoonSent = true;
      this.sendClient({ type: "ending_soon", remaining_seconds: remaining });
      this.sendGem({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "[SYSTEM] About a minute is left. Begin wrapping up warmly in your own words. Do not mention timers or limits." }] }],
          turnComplete: true,
        },
      });
    }
    if (remaining <= 0) {
      if (elapsed >= max) await this.finish("time_up");
      else if (!this.chargeP) await this.finish("balance_out"); // the boundary charge above already had its chance
    }
  }

  // -------------------------------------------------------------------------
  // Finish
  // -------------------------------------------------------------------------
  private async failWith(code: string, message: string, err: unknown): Promise<void> {
    void trackException(this.env, err, { uid: this.uid, route: "VoiceSessionDO", handled: true, app_name: APP, extra: { code, agent: this.agent?.id, session_id: this.sessionId } });
    this.sendClient({ type: "error", code, message });
    await this.finish("error");
  }

  private async finish(reason: EndReason): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
    if (this.setupTimer) { clearTimeout(this.setupTimer); this.setupTimer = null; }

    for (const m of this.captions.closeAll()) this.sendClient(m);
    this.sendClient({ type: "ended", reason, session_id: this.sessionId });
    const client = this.client;
    const gem = this.gem;
    this.client = null; this.gem = null;
    if (client) this.closeSocket(client, 1000, reason);
    if (gem) this.closeSocket(gem, 1000, "done");

    const seconds = this.callStartedAt ? Math.max(0, Math.round((Date.now() - this.callStartedAt) / 1000)) : 0;
    const elapsedFloor = this.callStartedAt ? Math.max(0, Math.floor((Date.now() - this.callStartedAt) / 1000)) : 0;
    if (!this.sessionId) return; // never got as far as a session row
    this.state.waitUntil(this.persist(reason, seconds, elapsedFloor));
  }

  /** [AUMFE-VOICE-BILLING-1] Settle the wallet exactly once: finish any in-flight/due charge, then release the hold. */
  private async settleBilling(reason: EndReason, elapsedFloor: number): Promise<{ minutes: number; tokens: number; released: number } | null> {
    await this.reserveP?.catch(() => undefined);
    await this.chargeP?.catch(() => undefined);
    if (this.bill && reason !== "balance_out" && reason !== "error") {
      // A call that ended just after a minute boundary but before the next tick still owes that minute (never past the cap).
      try { await this.chargeDue(Math.min(elapsedFloor, Math.max(0, this.cfg.voiceAgentMaxSeconds - 1))); } catch (e) {
        void trackException(this.env, e, { uid: this.uid, route: "VoiceSessionDO.finalCharge", handled: true, app_name: APP, extra: { session_id: this.sessionId } });
      }
    }
    // The hold may exist even when the call never started billing (payer set), so release whenever we have a payer.
    const released = this.payer ? await releaseHold(this.env, this.payer, this.sessionId) : 0;
    if (!this.bill) return null;
    const { state, firstClose } = closeBilling(this.bill);
    this.bill = state;
    if (!firstClose) return null;
    return { minutes: state.minutesCharged, tokens: state.tokensCharged, released };
  }

  private async persist(reason: EndReason, seconds: number, elapsedFloor: number): Promise<void> {
    const billed = await this.settleBilling(reason, elapsedFloor);
    if (billed) {
      this.ev("voice_session_billed", { uid: this.uid, session_id: this.sessionId, minutes_charged: billed.minutes, tokens: billed.tokens, released: billed.released });
    }
    const costPaise = this.bill ? chargedPaise(this.bill) : meterCostPaise(seconds, this.cfg.voiceAgentFreeSeconds, this.cfg.voiceAgentPricePerMinPaise);
    const transcript = buildTranscript(this.captions.lines, this.agent.name);
    try {
      await endSession(this.env, this.uid, this.sessionId, transcript, { minutes: seconds / 60, costPaise, ctx: this.state });
    } catch (e) {
      void trackException(this.env, e, { uid: this.uid, route: "VoiceSessionDO.endSession", handled: true, app_name: APP, extra: { session_id: this.sessionId } });
    }
    const ok = reason !== "error" && reason !== "server" && this.firstAudioAt > 0;
    this.ev("voice_session_ended", {
      seconds, reason, tool_calls: this.toolCalls, ok, agent: this.agent.id, uid: this.uid,
      cost_paise: costPaise, billing: this.bill ? "live" : "test", turns: this.turns, reconnects: this.reconnects, model: this.model,
    });
    const usd = liveCostUsd(this.usage, this.inBytes, this.outBytes);
    const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
    this.ev("$ai_generation", {
      "$ai_model": this.model,
      "$ai_provider": "google",
      "$ai_input_tokens": this.usage.inAudio + this.usage.inText,
      "$ai_output_tokens": this.usage.outAudio + this.usage.outText,
      "$ai_total_cost_usd": round6(usd),
      "$ai_trace_id": this.sessionId,
      "$ai_span_name": "voice_guide_call",
      agent: this.agent.id, have_token_usage: this.usage.have, in_bytes: this.inBytes, out_bytes: this.outBytes,
    });
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------
  private setAgentState(s: AgentState): void {
    if (this.agentState === s && s !== "connecting") return;
    this.agentState = s;
    this.sendClient({ type: "agent_state", state: s });
  }

  private sendClient(m: ServerMsg): void {
    // A failed send means the browser is gone; its close listener ends the call.
    try { this.client?.send(JSON.stringify(m)); } catch { /* browser gone — handled by the close listener */ }
  }

  private sendAudio(pcm: Uint8Array): void {
    try { this.client?.send(pcm); } catch { /* browser gone — handled by the close listener */ }
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    try { ws.close(code, reason.slice(0, 100)); } catch { /* already closed */ }
  }

  private ev(event: string, props: Record<string, unknown> = {}): void {
    void trackUserContact(this.env, this.uid, this.email, null, event, APP, { ...props, agent: props.agent ?? this.agent?.id, session_id: this.sessionId }, this.sessionId || undefined);
  }
}
