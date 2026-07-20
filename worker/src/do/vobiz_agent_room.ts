// VobizAgentRoom — [AVA-PSTN-AGENT-1] Live Gemini agent on CELL (Vobiz DID)
// calls via bidirectional media streams (Specs/PLAN-2026-07-19-vobiz-media-
// stream-agent.md). One instance per PSTN agent session id (`pstn-<CallUUID>`).
//
// This is a TRANSPORT ADAPTATION of do/reception_room.ts (the in-app Gemini
// Live bridge): the Gemini side (prompt handling, CLOSING state, goodbye grace,
// per-second billing accrual [RECEPT-BILLING-3], exact settle, cost ledger,
// margin alert, telemetry, recording→R2→inbox→push) is kept as-is; ONLY the
// client transport differs. Instead of raw binary PCM WS frames to the Flutter
// app, this DO speaks the Vobiz media-stream JSON protocol (verified against
// vobiz.ai/docs/xml/stream/stream-events, 2026-07-19):
//
//   Vobiz → us : {event:"start", start:{streamId, callId, mediaFormat}}   (once)
//                {event:"media", media:{track:"inbound", payload:<b64 L16@16k>}}
//                {event:"playedStream"|"clearedAudio"}                    (acks)
//                socket CLOSE = the call ended (no inbound "stop" JSON)
//   us → Vobiz : {event:"playAudio", streamId, media:{contentType:"audio/x-l16",
//                 sampleRate:24000, payload:<b64 raw mono, NO WAV header>}}
//                {event:"checkpoint", streamId, name}    (after each Ava turn)
//                {event:"clearAudio", streamId}          (barge-in flush)
//                {event:"stop", streamId}                (we end the call)
//
// FORMATS LINE UP WITH GEMINI LIVE — NO RESAMPLING: inbound is L16 PCM16@16kHz
// (the <Stream contentType> pstn.ts requests) = exactly Gemini Live input;
// outbound playAudio declares sampleRate 24000 = exactly what Gemini emits.
//
// Lean by design where app-client concepts don't apply: NO ring-ack/countdown/
// client control frames, NO {t:"balance"} frames (nobody renders them on a cell
// call). Hard caps + zero-stop + CLOSING state + wrap cue all DO apply — the
// relay keeps time, never the model.
//
// Billing is IDENTICAL to reception_room (same per-second accrual, same
// `ava_receptionist_call` settle) — the sid is `pstn-<CallUUID>` so op_ids can
// never collide with in-app sessions; the internal cost ledger rows are tagged
// mode 'receptionist_agent_pstn' and all telemetry carries transport:"vobiz".
import type { Env } from "../types";
import { trackUserContact, metric } from "../hooks";
import { dmConvId } from "../authz";
import { contactFor, nameFor } from "../lib/identity";
import { chargeAmount } from "../feature_pricing"; // [RECEPT-BILLING-3] exact per-second settle
import { readConfig } from "../routes/config";
import { walletOp } from "../routes/wallet"; // [RECEPT-BILLING-3] start-of-call balance read (accrual + zero-stop)
import { metaDb } from "../db/shard";
// Engine imports are FINE here (this is engine code; the no-engine-import rule
// binds routes/pstn.ts only). The prompt is the SAME [AVA-INDIA-TUNE-1] 8-rule
// composition the in-app agent uses, so the PSTN agent inherits every behavior
// rule (Hinglish mirroring, aap-first etiquette, one-goodbye, end_call, …).
import { composeReceptionistPrompt, RECEPTIONIST_MODEL_DEFAULT, AVA_VOICE } from "../routes/receptionist";
import { matchAvatokPhones } from "../routes/api";
import { recordCallSummary, receptOutcome } from "../lib/recept_stats"; // [RECEPT-STATS-1] canonical call summary
import { e164Country } from "../lib/e164_country";                      // [RECEPT-STATS-1] caller_country from E.164
// [AVA-CAMP-C-ROOM] campaign-mode-only imports — never touched by the
// inbound receptionist path (only referenced inside `if (campaignMode)` /
// `if (this.campaign)` branches below).
import { ToolRuntime } from "../lib/tool_runtime";
import { buildCampaignTools } from "../lib/campaign_tools";
// [AVA-CAMP-F4-ROOM] campaign-mode-only warm-handover import — never touched
// by the inbound receptionist path (only referenced inside `if (this.campaign)`
// branches below). initiateHandover() owns the outbound transfer leg + the
// FSM's HandoverRequested→DialHuman transition; this room only calls it and
// polls the KV bridge-confirmed flag it writes.
import { initiateHandover } from "../lib/campaign_handover";
// [AVA-CAMP-Q-VOICES] campaign-mode-only voice selection — validates
// kv.voice_persona (seeded by campaign_pstn.ts from campaigns.voice_persona)
// against the actual Gemini Live prebuilt-voice catalog before trusting it as
// this call's voice_name. Never touched by the inbound receptionist path.
import { CAMPAIGN_VOICE_IDS, CAMPAIGN_VOICE_GENDER } from "../routes/campaign_voices";

/** Redact secrets from free-text error strings BEFORE telemetry (same scrubber
 *  as reception_room.ts — the Gemini URL carries ?key=AIza…). */
function scrubSecrets(s: string): string {
  return s
    .replace(/([?&](?:key|access_token|token|api_key)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, "[redacted-key]")
    .replace(/auth_tokens\/[^&\s"']+/g, "auth_tokens/[redacted]")
    .replace(/[A-Za-z0-9_\-]{40,}/g, "[redacted]");
}

// Gemini 3.1 Flash Live audio pricing (mirrors reception_room.ts).
const LIVE_AUDIO_IN_USD_PER_MIN = 0.005;
const LIVE_AUDIO_OUT_USD_PER_MIN = 0.018;
const LIVE_TEXT_IN_USD_PER_M = 0.75;
const LIVE_TEXT_OUT_USD_PER_M = 4.50;
const LIVE_AUDIO_IN_USD_PER_M = 3.00;
const LIVE_AUDIO_OUT_USD_PER_M = 12.00;

// Conversation-budget caps ([AVA-CONVO-BUDGET-1] defaults — overridable from the
// receptWrapCueMs/receptCloseMs/receptHardCapMs numeric config keys).
const DEFAULT_WRAP_CUE_MS = 120_000;
const DEFAULT_CLOSE_MS = 160_000;
const DEFAULT_HARD_CAP_MS = 180_000;

// Outbound playAudio chunking: Vobiz docs recommend ~20–60ms chunks for
// responsive barge-in (L16@24k = 48000 B/s → 60ms = 2880 bytes). Small chunks
// maximise how much a clearAudio barge-in can cancel.
const PLAY_CHUNK_BYTES = 2880;

interface PstnAgentKv {
  owner_uid: string;
  caller_e164: string | null;
  call_uuid: string | null;
  ts: number;
  // [AVA-CAMP-C-ROOM] optional campaign-mode fields, seeded by
  // routes/campaign_pstn.ts's handleAnswer(). All optional and additive —
  // an inbound-receptionist KV blob (routes/pstn.ts) never sets `mode`, so
  // every campaign-only field below is simply absent there.
  mode?: "campaign";
  campaign_id?: string;
  attempt_uuid?: string;
  compiled_prompt?: string;
  kb_store?: string | null;
  billing_ref?: string;
  tokens_per_min?: number;
  language_hint?: string | null;
  voice_persona?: string | null;
  contact_name?: string | null;
  contact_e164?: string | null;
  booking_enabled?: boolean;
}

/** [AVA-CAMP-C-ROOM] Resolved campaign-mode context for one call attempt —
 *  set once on this.campaign at init time, null for every inbound call.
 *  [AVA-CAMP-F4-ROOM] handoverEnabled/handoverNumber/didE164/campaignName are
 *  additive fields loaded from the `campaigns` row (the campaign_pstn KV seed
 *  doesn't carry them) so the room can declare + drive `transfer_to_human`. */
interface CampaignRoomCtx {
  campaignId: string;
  attemptUuid: string;
  ownerUid: string;
  contactName: string | null;
  contactE164: string | null;
  bookingEnabled: boolean;
  handoverEnabled: boolean;
  handoverNumber: string | null;
  didE164: string | null;
  campaignName: string | null;
}

interface AgentInit {
  sid: string; owner_uid: string; caller_uid: string | null;
  caller_phone: string | null; caller_name: string | null; call_id: string | null;
  voice_name: string; file_search_store: string | null;
  system_prompt: string; model: string;
  soft_cap_ms: number; hard_cap_ms: number; wrap_cue_ms: number; wrap_soft: boolean;
  started_at: number;
  language_code: string | null; activation_mode: string;
  owner_name: string | null; ava_name: string;
}

// [AVA-CLOSING-STATE-1] farewell detection (EN + HI incl. romanized) — same as
// reception_room.ts.
function isAvaFarewell(t: string): boolean {
  const s = t.toLowerCase();
  return /\b(good\s?bye|bye(\s?bye)?|take care|talk (to you )?soon|have a (great|good|nice|lovely|wonderful) (day|evening|morning|afternoon|night|one))\b/.test(s)
    || /(अलविदा|फिर मिलेंगे|ध्यान रखिए|ध्यान रखना|शुभ दिन|आपका दिन (शुभ|अच्छा) (हो|रहे)|नमस्ते।?\s*$)/.test(t)
    || /\b(alvida|phir milenge|dhyan rakhiye)\b/.test(s);
}

// [RECEPT-BILLING-3] internal per-call cost ledger — self-migrating, once per
// isolate (same guarded pattern as reception_room.ts).
let _costLedgerEnsured = false;
async function ensureCallCostLedger(env: Env): Promise<void> {
  if (_costLedgerEnsured) return;
  _costLedgerEnsured = true;
  try {
    await metaDb(env).prepare(
      "CREATE TABLE IF NOT EXISTS call_cost_ledger (call_id TEXT PRIMARY KEY, user_id TEXT, mode TEXT, start_ts INTEGER, end_ts INTEGER, duration_seconds INTEGER, tokens_charged REAL, actual_api_cost_inr REAL)",
    ).run();
  } catch { _costLedgerEnsured = false; /* retry on next call */ }
}

/** [AVA-CAMP-Q-VOICES] campaign-mode-only: resolve the seeded voice_persona
 *  into a real Gemini Live voice_name, falling back to AVA_VOICE for an
 *  absent/unknown value (campaigns created before this catalog shipped, or a
 *  free-text legacy value) — a bad voice_name would otherwise break the
 *  BidiGenerateContent setup for the whole call. Never reached on the
 *  inbound path (that branch always uses AVA_VOICE directly, unchanged). */
function resolveCampaignVoice(voicePersona: string | null | undefined): string {
  const v = (voicePersona || "").trim();
  return v && CAMPAIGN_VOICE_IDS.has(v) ? v : AVA_VOICE;
}

function guessLangFromText(s: string): string {
  if (!s) return "und";
  if (/[ऀ-ॿ]/.test(s)) return "hi";
  if (/[؀-ۿ]/.test(s)) return "ar";
  if (/[֐-׿]/.test(s)) return "he";
  if (/[぀-ヿ]/.test(s)) return "ja";
  if (/[가-힯]/.test(s)) return "ko";
  if (/[一-鿿]/.test(s)) return "zh";
  if (/[Ѐ-ӿ]/.test(s)) return "ru";
  if (/[฀-๿]/.test(s)) return "th";
  if (/[a-zA-Z]/.test(s)) return "und-latn";
  return "und";
}

/** Caller-local time-of-day word. PSTN DID callers are on Indian cells, so IST
 *  is the honest guess (routes/receptionist.ts derives this from the app
 *  client's timezone, which a Vobiz webhook doesn't carry). */
function timeOfDayWordIST(): string {
  try {
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }).format(new Date()));
    if (h >= 5 && h < 12) return "morning";
    if (h >= 12 && h < 17) return "afternoon";
    if (h >= 17 && h < 22) return "evening";
    return "day";
  } catch { return "day"; }
}

export class VobizAgentRoom {
  private state: DurableObjectState;
  private env: Env;

  private client: WebSocket | null = null;   // the Vobiz media-stream socket
  private gem: WebSocket | null = null;
  private init: AgentInit | null = null;
  private startedAt = 0;
  private wrapCueTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  private finalized = false;
  private wrapCueInjected = false;
  private idleNudges = 0;
  private closePending = false;
  // [AVA-NATURAL-CLOSE-1] caller SPEECH budget (20s steer / 25s close).
  private callerSpeechMs = 0;
  private lastInTAt = 0;
  private steerInjected = false;
  private avaSpeaking = false;
  private selfClosed = false;
  // [AVA-CLOSING-STATE-1] terminal CLOSING state.
  private closing = false;
  private avaTurnText = "";
  private goodbyeGraceTimer: ReturnType<typeof setTimeout> | null = null;

  // Vobiz transport state.
  private streamId: string | null = null;
  private awaitingClear = false;             // clearAudio sent, clearedAudio not yet back
  private pendingPlayback: Uint8Array[] = []; // Gemini audio queued while awaitingClear
  private pendingPlaybackBytes = 0;
  private checkpointSeq = 0;

  private ownerEmail: string | null = null;
  private ownerPhone: string | null = null;
  private firstAudioSent = false;
  private wrapping = false;

  // [AVA-CAMP-C-ROOM] campaign-mode context — null for every inbound call.
  // Presence of this.campaign is the ONLY gate every campaign branch below
  // checks; inbound sessions never set it, so those branches always no-op.
  private campaign: CampaignRoomCtx | null = null;
  private toolRuntime: ToolRuntime | null = null;
  // [AVA-CAMP-F4-ROOM] transfer_to_human's OWN 1/call limit — deliberately NOT
  // part of ToolRuntime's 6-call budget (spec §19 seam 1). Always false
  // (unused) on the inbound path.
  private handoverAttempted = false;

  private inText: string[] = [];
  private outText: string[] = [];
  private dialog: Array<{ who: "ava" | "caller"; text: string }> = [];
  private pcmOut: Array<{ caller: boolean; pcm: Uint8Array }> = [];
  private pcmBytes = 0;
  private avaBytes = 0;
  private callerRecBytes = 0;
  private callerPeak = 0;
  private inBytes = 0;
  private turnCount = 0;
  private liveTokIn = { audio: 0, text: 0 };
  private liveTokOut = { audio: 0, text: 0 };
  private haveLiveUsage = false;
  // [RECEPT-BILLING-3] per-second accrual (5 hundredths/s = 3 tok/min). No
  // {t:"balance"} frames on PSTN (nobody renders them) — accrual + zero-stop only.
  private startBalance: number | null = null;
  private accruedHundredths = 0;
  private accrualTimer: ReturnType<typeof setInterval> | null = null;
  private zeroStopFired = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private static IDLE_MS = 10_000;
  private static MAX_REC_BYTES = 12 * 1024 * 1024;
  private static MAX_PENDING_PLAYBACK = 1024 * 1024; // barge-in queue safety cap

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    // sid = trailing path segment of /api/pstn-agent/stream/<secret>/<sid>
    // (the route already verified the secret before reaching this DO).
    const url = new URL(req.url);
    const segs = url.pathname.split("/").filter(Boolean);
    const sid = decodeURIComponent(segs[segs.length - 1] || "");
    if (!sid) return new Response("forbidden", { status: 403 });

    const kv = await this.env.TOKENS.get(`pstn_agent:${sid}`, "json").catch(() => null) as PstnAgentKv | null;
    if (!kv || !kv.owner_uid) return new Response("forbidden", { status: 403 });
    // Single-use init record — burn it so the WS can't be re-opened.
    this.env.TOKENS.delete(`pstn_agent:${sid}`).catch(() => {});

    // [AVA-CAMP-C-ROOM] campaign-mode gate. `kv.mode === "campaign"` is the
    // ONLY way this becomes true — an inbound-receptionist KV blob (written
    // by routes/pstn.ts) never sets `mode`, so campaignMode is false and
    // every branch below that checks it takes the exact original code path.
    const campaignMode = kv.mode === "campaign";

    // ── Compose the init server-side (the PSTN lane has no /start route; the
    // minimal KV blob from pstn.ts + the owner's D1 settings are the source).
    const cfg: any = await readConfig(this.env).catch(() => ({} as any));
    let s: any = null;
    if (!campaignMode) {
      try {
        s = await metaDb(this.env).prepare("SELECT * FROM receptionist_settings WHERE owner_uid=?1")
          .bind(kv.owner_uid).first<any>();
      } catch { /* defaults below */ }
      if (!s) s = { owner_uid: kv.owner_uid, enabled: 1, voice_name: AVA_VOICE };
    }

    // Caller identity best-effort: E.164 → AvaTOK uid/name via matchAvatokPhones
    // (never block the call on it — an unknown cell number just greets generically).
    let callerUid: string | null = null;
    let callerName: string | null = null;
    if (!campaignMode && kv.caller_e164) {
      try {
        const m = await matchAvatokPhones(this.env, { numbers: [kv.caller_e164] });
        if (m.length > 0) { callerUid = m[0].uid; callerName = m[0].name ?? null; }
      } catch { /* generic greeting */ }
    } else if (campaignMode) {
      // No AvaTOK-uid resolution for campaign contacts — the compiled_prompt
      // already carries whatever the campaign wizard knows about the contact.
      callerName = kv.contact_name || null;
    }
    let ownerName: string | null = null;
    let ownerGender: string | null = null;
    if (!campaignMode) {
      ownerName = (String(s.display_name || "").trim())
        || (await nameFor(this.env, kv.owner_uid).catch(() => null)) || null;
      try {
        const gr = await metaDb(this.env).prepare("SELECT gender FROM users WHERE uid=?1")
          .bind(kv.owner_uid).first<{ gender: string | null }>();
        ownerGender = gr?.gender ?? null;
      } catch { /* neutral */ }
    }

    const n = (v: unknown, fb: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fb);
    const now = Date.now();
    this.init = campaignMode ? {
      // ── [AVA-CAMP-C-ROOM] campaign-mode init: compiled_prompt IS the system
      // instruction (composeReceptionistPrompt is never called here), and
      // file_search_store comes from the campaign's kb_store, not the
      // receptionist_settings row (which was never loaded above).
      sid,
      owner_uid: kv.owner_uid,
      caller_uid: null,
      caller_phone: kv.contact_e164 || null,
      caller_name: callerName,
      call_id: kv.call_uuid || null,
      // [AVA-CAMP-Q-VOICES] the campaign's chosen voice (campaigns.voice_persona,
      // seeded into this KV blob by campaign_pstn.ts's handleAnswer()), validated
      // against the real Gemini Live catalog — falls back to AVA_VOICE for an
      // absent/unrecognized value so a bad seed can never break the call.
      voice_name: resolveCampaignVoice(kv.voice_persona),
      file_search_store: kv.kb_store || null,
      system_prompt: kv.compiled_prompt || "",
      model: (this.env as any).RECEPTIONIST_MODEL || RECEPTIONIST_MODEL_DEFAULT,
      soft_cap_ms: n(cfg.receptCloseMs, DEFAULT_CLOSE_MS),
      hard_cap_ms: n(cfg.receptHardCapMs, DEFAULT_HARD_CAP_MS),
      wrap_cue_ms: n(cfg.receptWrapCueMs, DEFAULT_WRAP_CUE_MS),
      wrap_soft: false,
      started_at: now,
      language_code: kv.language_hint || null,
      activation_mode: "campaign",
      owner_name: null,
      ava_name: "Ava",
    } : {
      sid,
      owner_uid: kv.owner_uid,
      caller_uid: callerUid,
      caller_phone: kv.caller_e164 || null,
      caller_name: callerName,
      call_id: kv.call_uuid || null,
      voice_name: AVA_VOICE, // P12: Ava's one canonical female voice
      file_search_store: s.file_search_store || null,
      // SAME prompt composition as the in-app agent ([AVA-INDIA-TUNE-1] 8-rule
      // brief + [RECEPT-MODE-1]); activation "rings" — the cell call was
      // forwarded because the owner didn't pick up.
      system_prompt: composeReceptionistPrompt(s, {
        callerName, activationMode: "rings", ownerName, gender: ownerGender,
        engine: "gemini", timeOfDay: timeOfDayWordIST(),
      }),
      model: (this.env as any).RECEPTIONIST_MODEL || RECEPTIONIST_MODEL_DEFAULT,
      soft_cap_ms: n(cfg.receptCloseMs, DEFAULT_CLOSE_MS),
      hard_cap_ms: n(cfg.receptHardCapMs, DEFAULT_HARD_CAP_MS),
      wrap_cue_ms: n(cfg.receptWrapCueMs, DEFAULT_WRAP_CUE_MS),
      wrap_soft: cfg.callMenuEnabled === true,
      started_at: now,
      language_code: s.answer_lang || s.language_code || null,
      activation_mode: "rings",
      owner_name: ownerName,
      ava_name: (String(s.persona_name || "Ava").trim()) || "Ava",
    };
    this.startedAt = now;

    // [AVA-CAMP-C-ROOM] resolved campaign context for tool-building + the
    // tools_used persist in finalize(). Null (unchanged default) on every
    // inbound call.
    this.campaign = campaignMode ? {
      campaignId: kv.campaign_id || "",
      attemptUuid: kv.attempt_uuid || "",
      ownerUid: kv.owner_uid,
      contactName: kv.contact_name || null,
      contactE164: kv.contact_e164 || null,
      bookingEnabled: !!kv.booking_enabled,
      // Filled in by the D1 SELECT immediately below — defaults keep
      // transfer_to_human undeclared if that lookup fails (fail-closed).
      handoverEnabled: false,
      handoverNumber: null,
      didE164: null,
      campaignName: null,
    } : null;

    // [AVA-CAMP-F4-ROOM] campaign-mode-only: load handover_enabled,
    // handover_number, did_e164, name from the campaigns row. The
    // campaign_pstn KV seed doesn't carry these, so this is a small
    // additive D1 read at init, gated behind campaignMode/this.campaign —
    // never reached on the inbound path. Best-effort: a failed/absent read
    // just leaves handoverEnabled=false, so transfer_to_human is simply not
    // declared (fail-closed, never a hard failure of the call).
    if (this.campaign) {
      try {
        const cRow = await metaDb(this.env).prepare(
          "SELECT handover_enabled, handover_number, did_e164, name FROM campaigns WHERE id=?1",
        ).bind(this.campaign.campaignId).first<any>();
        if (cRow) {
          this.campaign.handoverEnabled = !!cRow.handover_enabled && !!cRow.handover_number;
          this.campaign.handoverNumber = cRow.handover_number || null;
          this.campaign.didE164 = cRow.did_e164 || null;
          this.campaign.campaignName = cRow.name || null;
        }
      } catch { /* fail-closed: no handover this call */ }
    }

    // Session row so finalize's UPDATE + the cockpit have a record (best-effort).
    // Reads from this.init (not raw kv) so this line is identical in both
    // modes — inbound values match kv byte-for-byte since that's exactly how
    // this.init was built above.
    try {
      await metaDb(this.env).prepare(
        `INSERT OR IGNORE INTO receptionist_sessions
           (id, owner_uid, caller_uid, caller_phone, caller_name, call_id, activation_mode, status, started_at, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,'active',?8,?8,?8)`,
      ).bind(
        sid, kv.owner_uid,
        // [AVA-CAMP-C-ROOM] inbound uses the ORIGINAL literal expressions
        // (byte-for-byte identical to pre-campaign behavior — activation_mode
        // stays "rings"); campaign mode uses this.init's resolved values.
        this.campaign ? this.init.caller_uid : callerUid,
        this.campaign ? this.init.caller_phone : (kv.caller_e164 || null),
        this.campaign ? this.init.caller_name : callerName,
        this.campaign ? this.init.call_id : (kv.call_uuid || null),
        this.campaign ? this.init.activation_mode : "rings",
        now,
      ).run();
    } catch { /* best-effort */ }

    try {
      const c = await contactFor(this.env, kv.owner_uid);
      this.ownerEmail = c.email; this.ownerPhone = c.phone;
    } catch { /* best-effort */ }
    // [RECEPT-BILLING-3] start-of-call balance read — fail-open (null skips the
    // zero-stop; the exact settle at finalize still bills). [AVA-CAMP-C-ROOM]:
    // SKIPPED entirely in campaign mode — the room must not call any wallet op;
    // CampaignDO.onCallEnded owns reserve→consume→release. startBalance stays
    // null, which onAccrualTick already treats as "no zero-stop" (fail-open).
    if (!campaignMode) {
      try {
        const b = await walletOp(this.env, kv.owner_uid, { op: "balance", uid: kv.owner_uid });
        if (b.status === 200) this.startBalance = Math.max(0, Number(b.body?.balance ?? 0));
      } catch { /* fail-open */ }
    }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.client = server;

    server.addEventListener("message", (ev) => this.onVobizMessage(ev));
    // Vobiz does NOT send an inbound "stop" JSON when the call ends — the socket
    // close IS the end-of-call signal (docs: concepts/streaming-websockets).
    server.addEventListener("close", () => this.finalize("caller_hangup"));
    server.addEventListener("error", () => this.finalize("error"));

    this.connectGemini().catch((e) => {
      this.ev("ava_recept_gemini_connect_failed", {
        via_gateway: false,
        error_scrubbed: scrubSecrets(String(e)).slice(0, 200),
        ms: Date.now() - this.startedAt,
      });
      this.failHard("gemini_connect_failed");
    });

    // Server-authoritative timeline (THE RELAY KEEPS TIME, not the model).
    this.wrapCueTimer = setTimeout(() => this.onWrapCue(), this.init.wrap_cue_ms);
    this.closeTimer = setTimeout(() => this.onSessionClose(), this.init.soft_cap_ms);
    this.hardTimer = setTimeout(() => this.finalize("hard_cap"), this.init.hard_cap_ms);
    this.accrualTimer = setInterval(() => this.onAccrualTick(), 1000);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Telemetry stamped with owner email/phone + one-call trace. Every event on
   *  this lane carries transport:"vobiz" so PostHog can split cell vs in-app. */
  private ev(event: string, props: Record<string, unknown> = {}): void {
    const i = this.init;
    if (!i) return;
    // [AVA-CAMP-Q-VOICES] campaign calls can now use a male voice — stamp the
    // real gender instead of assuming Ava's usual "woman" (which stays correct
    // for every inbound call, still pinned to AVA_VOICE=Aoede).
    const voiceGender = this.campaign ? (CAMPAIGN_VOICE_GENDER[i.voice_name] ?? "woman") : "woman";
    trackUserContact(this.env, i.owner_uid, this.ownerEmail, this.ownerPhone, event, "receptionist",
      { ...props, transport: "vobiz", call_id: i.call_id, activation_mode: i.activation_mode,
        model: i.model, voice: i.voice_name, voice_gender: voiceGender }, i.sid);
  }

  // -------------------------------------------------------------------------
  // Gemini Live (direct — same connection logic as reception_room.ts)
  // -------------------------------------------------------------------------
  private receptKey(): string | undefined {
    return this.env.RECEPTIONIST_GEMINI_API_KEY || this.env.GEMINI_API_KEY;
  }

  private geminiWsUrl(): { url: string; protocols: string[] } {
    const key = this.receptKey()!;
    // Workers open OUTBOUND WebSockets via fetch() with Upgrade — https scheme
    // required (wss:// throws in the runtime). See reception_room.ts.
    return {
      url: `https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`,
      protocols: [],
    };
  }

  private async connectGemini(): Promise<void> {
    const init = this.init!;
    if (!this.receptKey()) throw new Error("no gemini key");
    const { url, protocols } = this.geminiWsUrl();
    const headers: Record<string, string> = { Upgrade: "websocket" };
    if (protocols.length) headers["Sec-WebSocket-Protocol"] = protocols.join(", ");
    const resp = await fetch(url, { headers });
    const gem = (resp as any).webSocket as WebSocket | undefined;
    if (!gem) throw new Error("no upstream websocket");
    gem.accept();
    this.gem = gem;

    gem.addEventListener("message", (ev) => this.onGeminiMessage(ev));
    gem.addEventListener("close", () => this.finalize("model_closed"));
    gem.addEventListener("error", () => this.failHard("gemini_error"));

    this.ev("ava_recept_gemini_connect", {
      latency_ms: Date.now() - this.startedAt,
      via_gateway: false,
      model: init.model, voice: init.voice_name, language: init.language_code ?? "auto",
    });
    this.ev("live_session_open", { feature: "receptionist", verb: "speak", language: init.language_code ?? "auto" });

    const speechConfig: any = { voiceConfig: { prebuiltVoiceConfig: { voiceName: init.voice_name } } };
    if (init.language_code) speechConfig.languageCode = init.language_code;
    const setup: any = {
      model: `models/${init.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig,
      },
      systemInstruction: { parts: [{ text: init.system_prompt }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    // end_call tool only (+ optional owner KB). NO Google Search grounding —
    // same cost guard as reception_room.ts.
    const tools: any[] = [{
      functionDeclarations: [{
        name: "end_call",
        description: "End the phone call. Invoke this the moment you have finished saying your ONE short goodbye line, once the caller's message is complete and they have nothing more to add. Do NOT wait for a timer — end the call yourself.",
        parameters: {
          type: "OBJECT",
          properties: {
            reason: {
              type: "STRING",
              description: "Why the call is ending: 'message_complete' (caller finished their message and fell silent), 'caller_bye' (caller said goodbye / that's all).",
              enum: ["message_complete", "caller_bye"],
            },
          },
        },
      }],
    }];
    const kbDisabled = String((this.env as any).RECEPT_KB_DISABLED || "") === "1";
    if (init.file_search_store && !kbDisabled) {
      tools.push({ fileSearch: { fileSearchStoreNames: [init.file_search_store] } });
    }
    // [AVA-CAMP-C-ROOM] campaign-mode tools — ToolRuntime + campaign_tools.ts
    // declarations are ADDED alongside end_call (never replace it). No-op
    // (this.campaign is null) on every inbound call.
    if (this.campaign) {
      this.toolRuntime = new ToolRuntime(buildCampaignTools(this.env, {
        ownerUid: this.campaign.ownerUid,
        attemptUuid: this.campaign.attemptUuid,
        campaignId: this.campaign.campaignId,
        contactName: this.campaign.contactName || undefined,
        contactE164: this.campaign.contactE164 || undefined,
        bookingEnabled: this.campaign.bookingEnabled,
        timeZone: "Asia/Kolkata",
      }));
      const campaignDecls = this.toolRuntime.declarations();
      if (campaignDecls.length > 0) {
        tools[0].functionDeclarations = [...tools[0].functionDeclarations, ...campaignDecls];
      }
      // [AVA-CAMP-F4-ROOM] transfer_to_human — a SYSTEM tool, declared
      // alongside (not through) ToolRuntime, so it never draws from the
      // 6-call budget (spec §8/§10, §19 seam 1). Only declared when the
      // campaign has handover enabled AND a handover number was resolved at
      // init; otherwise the tool simply doesn't exist for the model this
      // call, which is exactly H9's "handover disabled/ineligible" fallback
      // (the agent naturally can't call a tool it was never told about).
      if (this.campaign.handoverEnabled && this.campaign.handoverNumber) {
        tools[0].functionDeclarations = [...tools[0].functionDeclarations, {
          name: "transfer_to_human",
          description: "Transfer this call to a human at the business. Use this ONLY when the caller explicitly asks to speak to a person, or the conversation clearly needs a human (something you cannot resolve). Keep the caller engaged and let them know you're connecting them BEFORE invoking this — do not go silent.",
          parameters: {
            type: "OBJECT",
            properties: {
              reason: {
                type: "STRING",
                description: "One short phrase: why the caller needs a human (e.g. 'wants to speak to sales directly').",
              },
            },
            required: ["reason"],
          },
        }];
      }
    }
    setup.tools = tools;
    this.sendGem({ setup });
    this.ev("ava_recept_session_started", {
      setup_latency_ms: Date.now() - this.startedAt,
      has_kb: !!init.file_search_store && !kbDisabled,
    });
    // GREET FIRST — without this nudge Gemini's VAD waits for the caller and the
    // cell caller hears dead air.
    this.sendGem({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "[Caller connected — say your STEP 1 opening greeting now, exactly as instructed, then stop and listen.]" }] }],
        turnComplete: true,
      },
    });
    this.bumpIdle();
  }

  // -------------------------------------------------------------------------
  // Vobiz → us : JSON frames (start / media / acks). The call-end signal is the
  // socket close (handled in fetch's close listener), NOT an inbound stop.
  // -------------------------------------------------------------------------
  private onVobizMessage(ev: MessageEvent): void {
    if (this.finalized) return;
    const d = ev.data as any;
    let j: any;
    try {
      j = typeof d === "string" ? JSON.parse(d)
        : JSON.parse(new TextDecoder().decode(d as ArrayBuffer));
    } catch { return; }
    const event = String(j?.event || "");

    if (event === "start") {
      // Identifiers live INSIDE the nested start object (verified in docs).
      this.streamId = String(j.start?.streamId || j.streamId || "") || null;
      const mf = j.start?.mediaFormat || {};
      this.ev("ava_recept_vobiz_start", {
        stream_id: this.streamId, encoding: mf.encoding ?? null, rate: mf.sampleRate ?? null,
        format_ok: String(mf.encoding || "").includes("l16") && Number(mf.sampleRate) === 16000,
      });
      return;
    }
    if (event === "media") {
      const track = j.media?.track;
      if (track && track !== "inbound") return; // caller audio only (echo guard)
      const payload = j.media?.payload;
      if (typeof payload !== "string" || !payload) return;
      let bytes: Uint8Array;
      try { bytes = b64decode(payload); } catch { return; }
      this.onCallerAudio(bytes);
      return;
    }
    if (event === "clearedAudio") {
      // Barge-in flush confirmed — safe to enqueue replacement audio (playAudio
      // sent before this ack can race the flush and be partially dropped).
      this.awaitingClear = false;
      const queued = this.pendingPlayback;
      this.pendingPlayback = [];
      this.pendingPlaybackBytes = 0;
      for (const pcm of queued) this.sendPcmToCaller(pcm);
      return;
    }
    if (event === "playedStream") {
      // Ack that queued audio drained to the caller. Informational — the
      // goodbye grace timer covers the close path.
      return;
    }
    if (event === "stop") {
      // Defensive: docs say the close event is the real signal, but honor an
      // explicit inbound stop if one ever arrives.
      void this.finalize("caller_hangup");
      return;
    }
  }

  /** Caller PCM16@16k (decoded from a Vobiz media frame) → recording + Gemini.
   *  Body mirrors reception_room.onClientMessage's binary path. */
  private onCallerAudio(bytes: Uint8Array): void {
    if (this.finalized || !this.gem) return;
    // Wrap-up barge-in: once the firm close hits we stop relaying the caller so
    // the model isn't held in "listening" mode (same as the in-app lane).
    if (this.wrapping) return;
    this.inBytes += bytes.byteLength;
    // 2-WAY RECORDING: capture the caller's side (speech-energy frames only),
    // upsampled 16k→24k to match Ava's stream.
    if (this.pcmBytes < VobizAgentRoom.MAX_REC_BYTES && callerHasSpeech(bytes)) {
      const up = upsample16to24(bytes);
      const pk = peakOf(up);
      if (pk > this.callerPeak) this.callerPeak = pk;
      this.pcmOut.push({ caller: true, pcm: up }); this.pcmBytes += up.byteLength; this.callerRecBytes += up.byteLength;
      this.idleNudges = 0;
      this.bumpIdle();
    }
    this.sendGem({
      realtimeInput: { audio: { data: b64encode(bytes), mimeType: "audio/pcm;rate=16000" } },
    });
  }

  // -------------------------------------------------------------------------
  // us → Vobiz : playAudio / checkpoint / clearAudio / stop
  // -------------------------------------------------------------------------
  private sendVobiz(obj: unknown): void {
    try { this.client?.send(JSON.stringify(obj)); } catch { /* caller gone */ }
  }

  /** Gemini PCM16@24k → playAudio frames (b64 RAW mono, sampleRate declared
   *  24000 — never a WAV header, never resampled), chunked ~60ms so barge-in
   *  can cancel queued audio. While a clearAudio flush is in flight, queue. */
  private sendPcmToCaller(pcm: Uint8Array): void {
    if (this.finalized || !this.client) return;
    if (this.awaitingClear) {
      if (this.pendingPlaybackBytes < VobizAgentRoom.MAX_PENDING_PLAYBACK) {
        this.pendingPlayback.push(pcm);
        this.pendingPlaybackBytes += pcm.byteLength;
      }
      return;
    }
    const streamId = this.streamId || "";
    for (let off = 0; off < pcm.byteLength; off += PLAY_CHUNK_BYTES) {
      const chunk = pcm.subarray(off, Math.min(off + PLAY_CHUNK_BYTES, pcm.byteLength));
      this.sendVobiz({
        event: "playAudio",
        streamId,
        media: { contentType: "audio/x-l16", sampleRate: 24000, payload: b64encode(chunk) },
      });
    }
  }

  /** Barge-in: drop everything queued in Vobiz that hasn't reached the caller
   *  (replaces the in-app {t:"flush"} client frame). Pending playback we were
   *  holding is stale interrupted audio — drop it too. */
  private clearCallerAudio(): void {
    this.pendingPlayback = [];
    this.pendingPlaybackBytes = 0;
    this.awaitingClear = true;
    this.sendVobiz({ event: "clearAudio", streamId: this.streamId || "" });
  }

  /** Capture Gemini Live token usage (cumulative) split by modality. */
  private captureLiveUsage(u: any): void {
    try {
      const split = (details: any): { audio: number; text: number } => {
        const out = { audio: 0, text: 0 };
        if (Array.isArray(details)) {
          for (const d of details) {
            const n = Number(d?.tokenCount) || 0;
            if (String(d?.modality).toUpperCase() === "AUDIO") out.audio += n;
            else out.text += n;
          }
        }
        return out;
      };
      const inD = split(u.promptTokensDetails);
      const outD = split(u.responseTokensDetails ?? u.candidatesTokensDetails);
      if (inD.audio === 0 && inD.text === 0 && Number(u.promptTokenCount)) inD.text = Number(u.promptTokenCount);
      this.liveTokIn = inD;
      this.liveTokOut = outD;
      this.haveLiveUsage = true;
    } catch { /* best-effort */ }
  }

  // [RECEPT-BILLING-3] per-second accrual. Identical maths to reception_room;
  // the {t:"balance"} client frames are intentionally absent (no app client on a
  // cell call) — zero-stop + exact settle are unchanged.
  private onAccrualTick(): void {
    if (this.finalized) {
      if (this.accrualTimer) { clearInterval(this.accrualTimer); this.accrualTimer = null; }
      return;
    }
    this.accruedHundredths = Math.floor(((Date.now() - this.startedAt) / 1000) * 5);
    const bal = this.startBalance;
    if (bal == null) return; // balance unknown → no zero-stop (fail-open)
    const limitHundredths = Math.ceil(bal * 100);
    if (this.accruedHundredths > limitHundredths) this.accruedHundredths = limitHundredths;
    if (this.accruedHundredths >= limitHundredths && !this.zeroStopFired) {
      this.zeroStopFired = true;
      if (this.accrualTimer) { clearInterval(this.accrualTimer); this.accrualTimer = null; }
      this.ev("ava_recept_balance_exhausted", { at_ms: Date.now() - this.startedAt, start_balance: bal });
      this.sendGem({ realtimeInput: { audioStreamEnd: true } });
      this.sendGem({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "[SYSTEM] Balance exhausted. Say one short line that the call must end now, say goodbye, and invoke end_call." }] }],
          turnComplete: true,
        },
      });
      setTimeout(() => { if (!this.finalized) void this.finalize("balance_exhausted"); }, 6000);
    }
  }

  private bumpIdle(): void {
    if (this.finalized) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.onIdle(), VobizAgentRoom.IDLE_MS);
  }

  // Silence backstop — identical escalation to reception_room (check-in →
  // spoken close), with [AVA-CLOSING-STATE-1] making post-goodbye silence a
  // success (close, never nudge).
  private onIdle(): void {
    if (this.finalized) return;
    if (this.closing) { void this.finalize("ava_goodbye"); return; }
    if (this.wrapCueInjected) { void this.finalize("inactivity"); return; }
    if (this.inText.join("").trim().length > 0) { this.onWrapCue(); return; }
    if (this.idleNudges >= 1) { this.onWrapCue(); return; }
    this.idleNudges++;
    this.ev("ava_recept_idle_nudge", { at_ms: Date.now() - this.startedAt });
    this.sendGem({ realtimeInput: { audioStreamEnd: true } });
    this.sendGem({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "[SYSTEM] Caller is quiet. One short warm check-in. No goodbye yet." }] }],
        turnComplete: true,
      },
    });
    this.bumpIdle();
  }

  // Gemini → caller : audio out (playAudio frames) + transcript accumulation.
  private onGeminiMessage(ev: MessageEvent): void {
    if (this.finalized) return;
    let msg: any;
    try {
      msg = typeof ev.data === "string" ? JSON.parse(ev.data)
        : JSON.parse(new TextDecoder().decode(ev.data as ArrayBuffer));
    } catch { return; }

    if (msg.usageMetadata) this.captureLiveUsage(msg.usageMetadata);

    // Ava invoked end_call after her goodbye → hang up (audio drain grace).
    if (msg.toolCall) {
      const calls = msg.toolCall.functionCalls;
      const endCall = Array.isArray(calls) ? calls.find((c: any) => c?.name === "end_call") : null;
      if (endCall) {
        const rawReason = String(endCall?.args?.reason || "").trim();
        const reason = (rawReason === "caller_bye" || rawReason === "message_complete")
          ? rawReason : "message_complete";
        this.selfClosed = true;
        this.ev("ava_recept_self_closed", {
          reason,
          turns: this.turnCount,
          session_s: Math.round((Date.now() - this.startedAt) / 1000),
        });
        this.ev("ava_recept_ended_by_agent", { ms: Date.now() - this.startedAt, reason });
        setTimeout(() => { void this.finalize("ava_ended"); }, 1600);
        return;
      }
      // [AVA-CAMP-F4-ROOM] transfer_to_human — handled specially, NOT routed
      // through ToolRuntime (it must not consume the 6-call budget). Only
      // reachable when this.campaign is set (campaign mode declared it, and
      // only when handover is enabled) — never reachable on the inbound
      // path, where the tool was never declared.
      if (this.campaign && Array.isArray(calls)) {
        const handoverCall = calls.find((c: any) => c?.name === "transfer_to_human");
        if (handoverCall) {
          void this.handleTransferToHuman(String(handoverCall.id ?? ""), handoverCall.args ?? {});
        }
      }
      // [AVA-CAMP-C-ROOM] any OTHER declared function call — only reachable
      // when this.toolRuntime is set (campaign mode declared it above); an
      // inbound session's setup never declares anything but end_call, so
      // `calls` here is always empty/end_call-only on that path and this
      // no-ops. This is the room's first functionResponse send-back path —
      // there was none before. transfer_to_human is excluded here too (it's
      // handled above and never registered with ToolRuntime in the first
      // place, but the name is skipped defensively).
      if (this.toolRuntime && Array.isArray(calls)) {
        for (const c of calls) {
          if (!c || c.name === "end_call" || c.name === "transfer_to_human") continue;
          void this.handleCampaignToolCall(String(c.id ?? ""), String(c.name ?? ""), c.args ?? {});
        }
      }
    }

    const sc = msg.serverContent;
    if (sc) {
      // Barge-in: Gemini's VAD heard the caller over Ava → flush Vobiz's queued
      // playback so she goes silent on the handset instantly.
      if (sc.interrupted === true) {
        this.clearCallerAudio();
        this.ev("ava_recept_barge_in", { route: "gemini_vad", ms: Date.now() - this.startedAt });
      }
      const inT = sc.inputTranscription?.text;
      if (inT) {
        if (this.closing) {
          this.closing = false;
          if (this.goodbyeGraceTimer) { clearTimeout(this.goodbyeGraceTimer); this.goodbyeGraceTimer = null; }
          this.ev("ava_recept_closing_cancelled", { at_ms: Date.now() - this.startedAt });
        }
        this.inText.push(String(inT)); this.pushDialog("caller", String(inT));
        // [AVA-NATURAL-CLOSE-1] caller speech budget (20s steer / 25s close).
        const now = Date.now();
        const gap = this.lastInTAt > 0 ? now - this.lastInTAt : 0;
        this.callerSpeechMs += gap > 0 && gap <= 1500 ? gap : 300;
        this.lastInTAt = now;
        if (!this.steerInjected && this.callerSpeechMs >= 20_000) {
          this.steerInjected = true;
          this.sendGem({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: "[SYSTEM: The message is getting long. On your NEXT turn, gently wind the caller down in your own words and move to your one short goodbye. Never mention time limits or that time is up.]" }] }],
              turnComplete: false,
            },
          });
          this.ev("ava_recept_steer_cue", { at_ms: now - this.startedAt, speech_ms: this.callerSpeechMs });
        } else if (this.callerSpeechMs >= 25_000 && !this.wrapCueInjected) {
          this.ev("ava_recept_speech_cap", { at_ms: now - this.startedAt, speech_ms: this.callerSpeechMs });
          this.onWrapCue();
        }
      }
      const outT = sc.outputTranscription?.text;
      if (outT) {
        this.outText.push(String(outT)); this.pushDialog("ava", String(outT));
        this.avaTurnText += String(outT);
      }
      if (sc.turnComplete === true) {
        this.turnCount++;
        this.avaSpeaking = false;
        // checkpoint after each Ava turn — Vobiz answers playedStream when the
        // queued audio actually drained to the handset (unique name per turn).
        this.checkpointSeq++;
        this.sendVobiz({ event: "checkpoint", streamId: this.streamId || "", name: `turn-${this.checkpointSeq}` });
        // [AVA-CLOSING-STATE-1] farewell → CLOSING (grace close, nudges off).
        if (!this.closing && isAvaFarewell(this.avaTurnText)) {
          this.closing = true;
          this.ev("ava_recept_closing_state", { at_ms: Date.now() - this.startedAt, turn: this.turnCount });
          this.goodbyeGraceTimer = setTimeout(() => {
            if (!this.finalized && this.closing) void this.finalize("ava_goodbye");
          }, 1800);
        }
        this.avaTurnText = "";
        this.ev("ava_recept_turn", {
          turn: this.turnCount,
          in_chars: this.inText.join("").length,
          out_chars: this.outText.join("").length,
          in_bytes: this.inBytes,
          ava_bytes: this.pcmBytes,
          ms: Date.now() - this.startedAt,
        });
        if (this.closePending) { void this.finalize("time_up_wrap"); return; }
      }
      const parts = sc.modelTurn?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          const data = p?.inlineData?.data;
          if (typeof data === "string") {
            const pcm = b64decode(data);
            this.avaSpeaking = true;
            if (this.pcmBytes < VobizAgentRoom.MAX_REC_BYTES) {
              this.pcmOut.push({ caller: false, pcm }); this.pcmBytes += pcm.byteLength;
            }
            this.avaBytes += pcm.byteLength;
            this.bumpIdle();
            if (!this.firstAudioSent) {
              this.firstAudioSent = true;
              this.ev("ava_recept_first_audio", { ms: Date.now() - this.startedAt });
            }
            this.sendPcmToCaller(pcm);
          }
        }
      }
    }
  }

  // WRAP CUE — identical to reception_room (soft wind-down when wrap_soft, else
  // mic-gated firm close). No client softcap frame on this lane.
  private onWrapCue(): void {
    if (this.finalized || this.wrapCueInjected) return;
    this.wrapCueInjected = true;
    if (this.init?.wrap_soft === true) {
      this.sendGem({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "[SYSTEM] Begin wrapping up naturally. Finish within ~30 seconds. Do not mention time." }] }],
          turnComplete: true,
        },
      });
      metric(this.env, "ava_recept_softcap", [1]);
      this.ev("ava_recept_wrap_cue", { at_ms: Date.now() - this.startedAt, soft: true });
      return;
    }
    this.wrapping = true;
    // Under automatic VAD: end the caller's still-open turn so the model
    // actually answers the wrap nudge.
    this.sendGem({ realtimeInput: { audioStreamEnd: true } });
    this.sendGem({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "[SYSTEM] Close the call now: one short goodbye in your own words, then invoke end_call. Do not mention time." }] }],
        turnComplete: true,
      },
    });
    metric(this.env, "ava_recept_softcap", [1]);
    this.ev("ava_recept_wrap_cue", { at_ms: Date.now() - this.startedAt });
  }

  // SESSION CLOSE — never hard-cut mid-word.
  private onSessionClose(): void {
    if (this.finalized) return;
    if (this.avaSpeaking) {
      this.closePending = true;
      this.ev("ava_recept_close_deferred", { at_ms: Date.now() - this.startedAt });
      return;
    }
    void this.finalize("time_up_wrap");
  }

  private sendGem(obj: unknown): void {
    try { this.gem?.send(JSON.stringify(obj)); } catch { /* upstream gone */ }
  }

  /** [AVA-CAMP-C-ROOM] Run one campaign-mode tool call through ToolRuntime and
   *  send the result back to Gemini as a functionResponse. Only ever invoked
   *  from the toolCall handler above, which only calls it when
   *  this.toolRuntime is set (campaign mode) — never reachable on the inbound
   *  path. ToolRuntime.invoke() never throws (documented contract), so no
   *  try/catch is needed around it here. */
  private async handleCampaignToolCall(id: string, name: string, args: unknown): Promise<void> {
    if (!this.toolRuntime || !name) return;
    const result = await this.toolRuntime.invoke(name, args);
    this.sendGem({
      toolResponse: { functionResponses: [{ id, name, response: result }] },
    });
  }

  /** [AVA-CAMP-F4-ROOM] transfer_to_human — own 1/call limit, never routed
   *  through ToolRuntime (spec §19 seam 1). Only ever invoked from the
   *  toolCall handler above, itself gated on this.campaign — never reachable
   *  on the inbound path. */
  private async handleTransferToHuman(id: string, args: any): Promise<void> {
    if (!this.campaign || !id) return;
    const reason = String(args?.reason || "").trim() || "caller requested a human";

    if (this.handoverAttempted || !this.campaign.handoverEnabled || !this.campaign.handoverNumber) {
      this.sendGem({
        toolResponse: { functionResponses: [{ id, name: "transfer_to_human", response: { success: false, error_code: "unavailable" } }] },
      });
      return;
    }
    this.handoverAttempted = true;

    // Disable the wrap-up/hard-cap timers so the 8-min cue / 10-min cap
    // don't fire mid-handover (spec §8 "Wrap timers ... are disabled once a
    // handover begins"). Re-armed below if initiateHandover fails.
    if (this.wrapCueTimer) { clearTimeout(this.wrapCueTimer); this.wrapCueTimer = null; }
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
    if (this.hardTimer) { clearTimeout(this.hardTimer); this.hardTimer = null; }

    this.ev("ava_camp_handover_attempt", { attempt_uuid: this.campaign.attemptUuid, reason });

    let result: { ok: boolean; error_code?: string };
    try {
      result = await initiateHandover(this.env, {
        attemptUuid: this.campaign.attemptUuid,
        campaignId: this.campaign.campaignId,
        ownerUid: this.campaign.ownerUid,
        callerCallUuid: this.init?.call_id || "",
        didE164: this.campaign.didE164 || "",
        handoverNumber: this.campaign.handoverNumber,
        reason,
        contactName: this.campaign.contactName || undefined,
        campaignName: this.campaign.campaignName || undefined,
        // 1-line summary of the conversation so far for the human whisper.
        summary: this.buildTranscript().slice(-600),
      } as any);
    } catch (e) {
      result = { ok: false, error_code: "handover_error" };
      this.ev("ava_camp_handover_error", {
        attempt_uuid: this.campaign.attemptUuid,
        error_scrubbed: scrubSecrets(String(e)).slice(0, 200),
      });
    }

    if (!result.ok) {
      // H9-style graceful fallback: re-enable timers, let the agent continue
      // (it will apologize/offer a callback per the system prompt's guidance).
      this.rearmWrapTimers();
      this.sendGem({
        toolResponse: { functionResponses: [{ id, name: "transfer_to_human", response: { success: false, error_code: result.error_code || "handover_failed" } }] },
      });
      this.ev("ava_camp_handover_failed", { attempt_uuid: this.campaign.attemptUuid, error_code: result.error_code });
      return;
    }

    this.sendGem({
      toolResponse: { functionResponses: [{ id, name: "transfer_to_human", response: { success: true, message: "connecting you now" } }] },
    });
    this.ev("ava_camp_handover_initiated", { attempt_uuid: this.campaign.attemptUuid });
    void this.pollHandoverBridge(this.campaign.attemptUuid);
  }

  /** Re-arm the wrap-up/session-close/hard-cap timers with their REMAINING
   *  budget (relative to this.startedAt), used when a handover attempt fails
   *  and the AI must resume under the normal timeline. No-op past finalize. */
  private rearmWrapTimers(): void {
    if (this.finalized || !this.init) return;
    const elapsed = Date.now() - this.startedAt;
    if (!this.wrapCueTimer && !this.wrapCueInjected) {
      this.wrapCueTimer = setTimeout(() => this.onWrapCue(), Math.max(1000, this.init.wrap_cue_ms - elapsed));
    }
    if (!this.closeTimer) {
      this.closeTimer = setTimeout(() => this.onSessionClose(), Math.max(1000, this.init.soft_cap_ms - elapsed));
    }
    if (!this.hardTimer) {
      this.hardTimer = setTimeout(() => this.finalize("hard_cap"), Math.max(1000, this.init.hard_cap_ms - elapsed));
    }
  }

  /** [AVA-CAMP-F4-ROOM] Bounded poll of the KV bridge-confirmed flag the
   *  controller (campaign_handover.ts) writes INSIDE the JSON blob at
   *  `ho:<attemptUuid>` (field `bridge_confirmed:true` on caller-leg join),
   *  every ~2s for up to ~30s. On confirmation, finalize
   *  the AI leg via the normal finalize() path (reason 'handover') — the AI
   *  leaves only once BridgeConfirmed, never before (spec §4/§7). On
   *  timeout, CallFSM/CampaignDO (webhook-driven, independent of this room)
   *  already owns the handover failure path (H1-H9) and will have nudged the
   *  model or finalized the attempt itself if the human leg failed — this
   *  room just stops polling and lets the call continue on its own timers/
   *  end_call. */
  private async pollHandoverBridge(attemptUuid: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (this.finalized) return;
      let confirmed = false;
      try {
        // The controller stores handover state as ONE JSON blob at ho:<uuid>
        // (campaign_handover.ts writeBlobPatch), with bridge_confirmed:true set
        // on the caller-leg join — read the blob, not a flat sub-key.
        const raw = await this.env.TOKENS.get(`ho:${attemptUuid}`);
        if (raw) { try { confirmed = JSON.parse(raw).bridge_confirmed === true; } catch { /* malformed blob */ } }
      } catch { /* transient KV read error — keep polling */ }
      if (confirmed) {
        this.ev("ava_camp_handover_bridged", { attempt_uuid: attemptUuid });
        void this.finalize("handover");
        return;
      }
    }
    if (!this.finalized) this.ev("ava_camp_handover_poll_timeout", { attempt_uuid: attemptUuid });
  }

  private failHard(reason: string): void {
    this.ev("ava_recept_error", { stage: reason, fatal: true, ms: Date.now() - this.startedAt });
    this.finalize(reason);
  }

  // -------------------------------------------------------------------------
  // finalize once: persist session, post message + recording, push owner, bill.
  // Closing our WS ends the Vobiz call (keepCallAlive stream finished); we also
  // send an explicit stop frame first so Vobiz tears down immediately.
  // -------------------------------------------------------------------------
  private async finalize(reason: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.goodbyeGraceTimer) { clearTimeout(this.goodbyeGraceTimer); this.goodbyeGraceTimer = null; }
    if (this.wrapCueTimer) clearTimeout(this.wrapCueTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.accrualTimer) { clearInterval(this.accrualTimer); this.accrualTimer = null; }
    try { this.gem?.close(); } catch { /* ignore */ }
    try {
      if (this.streamId) this.sendVobiz({ event: "stop", streamId: this.streamId });
      this.client?.close(1000, reason);
    } catch { /* ignore */ }

    const init = this.init;
    if (!init) return;
    const now = Date.now();
    const durationS = Math.max(0, Math.round((now - this.startedAt) / 1000));
    this.ev("live_session_close", { feature: "receptionist", verb: "speak", reason, duration_s: durationS, turns: this.turnCount });
    const transcript = this.buildTranscript();

    // Recording → R2 (WAV, 24 kHz mono PCM16) with adaptive caller gain.
    let recordingUrl: string | null = null;
    try {
      if (this.pcmBytes > 0) {
        const recT0 = Date.now();
        const callerGain = this.callerPeak > 0
          ? Math.min(8, Math.max(1, 22000 / this.callerPeak)) : 1;
        const wav = pcm16ToWav(this.pcmOut, this.pcmBytes, 24000, callerGain);
        const phoneKey = (init.caller_phone || "unknown").replace(/[^\d+]/g, "") || "unknown";
        const key = `receptionist/${init.owner_uid}/${phoneKey}/${init.sid}.wav`;
        await this.env.BLOBS.put(key, wav, { httpMetadata: { contentType: "audio/wav" } });
        recordingUrl = key;
        this.ev("ava_recept_recording_stored", {
          bytes: wav.byteLength, ok: true, latency_ms: Date.now() - recT0,
          two_way: this.callerRecBytes > 0, ava_rec_bytes: this.avaBytes, caller_rec_bytes: this.callerRecBytes,
          caller_gain: Math.round(callerGain * 100) / 100, caller_peak: this.callerPeak,
        });
      }
    } catch (e) {
      this.ev("ava_recept_delivery_failed", { stage: "r2", error_scrubbed: scrubSecrets(String(e)).slice(0, 200) });
    }

    // No second-model summary (owner decision 2026-06-30) — recording + live
    // transcript only, exactly like the in-app lane.
    const summary: any = null;

    // Persist session.
    try {
      await metaDb(this.env).prepare(
        `UPDATE receptionist_sessions SET status='ended', ended_at=?2, duration_s=?3, cutoff_reason=?4,
           transcript=?5, recording_url=?6, updated_at=?2 WHERE id=?1`,
      ).bind(init.sid, now, durationS, reason, transcript || null, recordingUrl).run();
    } catch { /* ignore */ }

    const hadConversation = this.firstAudioSent || this.inText.length > 0 || this.pcmBytes > 0;
    try { await this.postMessage(init, summary, transcript, recordingUrl, durationS, hadConversation); } catch { /* best-effort */ }

    // [AVA-CAMP-C-ROOM] persist the mid-call tool audit trail. Only in
    // campaign mode (this.campaign set) — never runs on the inbound path.
    if (this.campaign) {
      try {
        await metaDb(this.env).prepare(
          `UPDATE campaign_call_attempts SET tools_used=?1 WHERE attempt_uuid=?2`,
        ).bind(JSON.stringify(this.toolRuntime?.getLog() ?? []), this.campaign.attemptUuid).run();
      } catch { /* best-effort */ }
    }

    // Suppress pstn.ts handleHangup's "missed call — no voicemail recorded"
    // fallback card: on the agent lane there is no record-cb, so without this
    // marker the owner would get a bogus missed-call card next to the agent's
    // own recept card. Same KV key the voicemail lane's record-cb sets.
    if (init.call_id) {
      try { await this.env.TOKENS.put(`pstn_delivered:${init.call_id}`, "1", { expirationTtl: 3600 }); } catch { /* best-effort */ }
    }

    this.ev("ava_recept_message_posted", {
      caller_phone: init.caller_phone, duration_s: durationS, cutoff_reason: reason,
      has_recording: !!recordingUrl, has_transcript: !!transcript,
      in_chars: this.inText.join("").length, out_chars: this.outText.join("").length,
    });
    this.ev("ava_recept_session_ended", {
      cutoff_reason: reason, duration_s: durationS, got_audio: this.firstAudioSent,
      ava_audio_bytes: this.avaBytes, recording_bytes: this.pcmBytes,
      caller_rec_bytes: this.callerRecBytes,
      caller_audio_bytes: this.inBytes, two_way_recording: this.callerRecBytes > 0,
      turns: this.turnCount,
      in_chars: this.inText.join("").length,
      out_chars: this.outText.join("").length, has_recording: !!recordingUrl,
    });
    metric(this.env, reason === "hard_cap" ? "ava_recept_hardcap" : "ava_recept_completed", [1, durationS]);

    // ── TOKEN BILLING [RECEPT-BILLING-3]: exact per-second settle, identical
    // rates to reception_room. sid is `pstn-<CallUUID>` so `<sid>:settle` can
    // never collide with an in-app session's op_id.
    const cfg: any = await readConfig(this.env).catch(() => ({} as any));
    const secondsExact = Math.max(0, (now - this.startedAt) / 1000);
    let hundredths = Math.ceil(secondsExact * 5);
    if (this.zeroStopFired && this.startBalance != null) {
      hundredths = Math.min(hundredths, Math.ceil(this.startBalance * 100));
    }
    const tokensToCharge = Math.ceil(hundredths / 100);
    let chargedTokens = 0; // [RECEPT-STATS-1] actual tokens charged, for the call summary
    // [AVA-CAMP-C-ROOM] Billing is owned by CampaignDO.onCallEnded
    // (reserve→consume-by-duration→release) — this room must NOT call any
    // wallet op on the campaign path, so the settle below is skipped entirely
    // when this.campaign is set (never true on the inbound path).
    if (!this.campaign && hadConversation && durationS > 0) {
      try {
        const r = await chargeAmount(this.env, init.owner_uid, "ava_receptionist_call", tokensToCharge,
          `${init.sid}:settle`, { forceMeter: cfg.receptBillingLive === true });
        chargedTokens = r.ok ? (r.charged ?? 0) : 0;
        this.ev("ava_recept_billed", {
          seconds: Math.round(secondsExact * 10) / 10, hundredths, tokens_charged: chargedTokens,
          charge_ok: r.ok, feature: "ava_receptionist_call", rate: 3,
          zero_stopped: this.zeroStopFired,
        });
      } catch { /* best-effort */ }
    }

    // ── [RECEPT-STATS-1] ONE canonical call summary (event + D1 mirror + 90d
    // retention + consent-gated AvaBrain feed) — lib/recept_stats.ts. PSTN lane:
    // caller_key is the E.164; country derives from the dialing prefix (a Vobiz
    // webhook carries no useful req.cf for the caller).
    const summaryReason = this.zeroStopFired ? "balance_exhausted" : reason;
    await recordCallSummary(this.env, {
      id: init.sid,
      owner_uid: init.owner_uid,
      ts: now,
      caller_key: init.caller_phone || init.caller_uid || "unknown",
      caller_name: init.caller_name ?? null,
      country: e164Country(init.caller_phone),
      mode: "agent",
      transport: "vobiz",
      duration_s: durationS,
      tokens: chargedTokens,
      outcome: receptOutcome(summaryReason, hadConversation),
      reason,
      owner_email: this.ownerEmail,
      owner_phone: this.ownerPhone,
    });

    // ── COST telemetry (Gemini Live audio) — same maths as reception_room.
    const inRate = Number((this.env as any).RECEPT_AUDIO_IN_USD_MIN) || LIVE_AUDIO_IN_USD_PER_MIN;
    const outRate = Number((this.env as any).RECEPT_AUDIO_OUT_USD_MIN) || LIVE_AUDIO_OUT_USD_PER_MIN;
    const inAudioS = this.inBytes / 32000;
    const outAudioS = this.avaBytes / 48000;
    const inAudioUsd = (inAudioS / 60) * inRate;
    const outAudioUsd = (outAudioS / 60) * outRate;
    const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
    const textInUsd = (this.liveTokIn.text / 1e6) * LIVE_TEXT_IN_USD_PER_M;
    const textOutUsd = (this.liveTokOut.text / 1e6) * LIVE_TEXT_OUT_USD_PER_M;
    const tokAudioInUsd = (this.liveTokIn.audio / 1e6) * LIVE_AUDIO_IN_USD_PER_M;
    const tokAudioOutUsd = (this.liveTokOut.audio / 1e6) * LIVE_AUDIO_OUT_USD_PER_M;
    const liveAudioUsd = this.haveLiveUsage ? (tokAudioInUsd + tokAudioOutUsd) : (inAudioUsd + outAudioUsd);
    const estUsd = liveAudioUsd + textInUsd + textOutUsd;

    this.ev("ava_recept_cost", {
      duration_s: durationS,
      in_audio_s: Math.round(inAudioS * 10) / 10,
      out_audio_s: Math.round(outAudioS * 10) / 10,
      in_audio_usd: round6(inAudioUsd),
      out_audio_usd: round6(outAudioUsd),
      have_token_usage: this.haveLiveUsage,
      tok_audio_in: this.liveTokIn.audio, tok_audio_out: this.liveTokOut.audio,
      tok_text_in: this.liveTokIn.text, tok_text_out: this.liveTokOut.text,
      text_in_usd: round6(textInUsd), text_out_usd: round6(textOutUsd),
      live_audio_usd: round6(liveAudioUsd),
      est_usd: round6(estUsd),
      in_rate_usd_min: inRate, out_rate_usd_min: outRate,
      cutoff_reason: reason,
      self_closed: this.selfClosed,
      wrap_cue_injected: this.wrapCueInjected,
      detected_lang: init.language_code || guessLangFromText(this.inText.join(" ")),
    });
    metric(this.env, "ava_recept_cost_usd_micro", [Math.round(estUsd * 1e6)]);

    // ── [RECEPT-BILLING-3] PER-CALL COST LEDGER + MARGIN ALERT. Ledger mode is
    // 'receptionist_agent_pstn' so PSTN agent minutes are separable from in-app.
    try {
      await ensureCallCostLedger(this.env);
      const usdInr = Number(cfg.usdInrRate) > 0 ? Number(cfg.usdInrRate) : 96.4;
      const actualInr = Math.round(estUsd * usdInr * 1e6) / 1e6;
      await metaDb(this.env).prepare(
        `INSERT OR REPLACE INTO call_cost_ledger
           (call_id, user_id, mode, start_ts, end_ts, duration_seconds, tokens_charged, actual_api_cost_inr)
         VALUES (?1, ?2, 'receptionist_agent_pstn', ?3, ?4, ?5, ?6, ?7)`,
      ).bind(init.sid, init.owner_uid, this.startedAt, now, durationS, hundredths / 100, actualInr).run();
      const minuteCostInr = actualInr / Math.max(1, durationS / 60);
      const alertPaise = Number(cfg.receptMarginAlertPaise) > 0 ? Number(cfg.receptMarginAlertPaise) : 220;
      if (minuteCostInr > alertPaise / 100) {
        this.ev("ava_recept_margin_alert", {
          minute_cost_inr: Math.round(minuteCostInr * 100) / 100, price_inr: 3,
          duration_s: durationS, est_usd: round6(estUsd), usd_inr: usdInr,
        });
      }
    } catch { /* internal bookkeeping is best-effort */ }
  }

  /** Append a transcript fragment, merging consecutive same-speaker fragments.
   *  [AVA-CONVO-TELEMETRY-1] one ava_recept_dialog event per speaker change. */
  private pushDialog(who: "ava" | "caller", text: string): void {
    const t = text.trim();
    if (!t) return;
    const last = this.dialog[this.dialog.length - 1];
    if (last && last.who === who) last.text = (last.text + " " + t).replace(/\s+/g, " ").trim();
    else {
      this.dialog.push({ who, text: t });
      this.ev("ava_recept_dialog", {
        who, seq: this.dialog.length, at_ms: Date.now() - this.startedAt,
        text: t.slice(0, 220),
      });
    }
  }

  private buildTranscript(): string {
    const avaName = (this.init?.ava_name || "Ava").trim() || "Ava";
    const callerName = (this.init?.caller_name || "Caller").trim() || "Caller";
    if (this.dialog.length > 0) {
      return this.dialog.map((d) => `${d.who === "ava" ? avaName : callerName}: ${d.text}`).join("\n");
    }
    const lines: string[] = [];
    if (this.inText.length) lines.push(callerName + ": " + this.inText.join(" ").trim());
    if (this.outText.length) lines.push(avaName + ": " + this.outText.join(" ").trim());
    return lines.join("\n");
  }

  /** Owner inbox card (+ caller-side ack when the caller is an AvaTOK user) —
   *  same envelope/conv shapes as reception_room so the FROZEN client renderer
   *  works unchanged. Phone-only callers land in the recept_ fallback conv. */
  private async postMessage(
    init: AgentInit, summary: any, transcript: string, recordingUrl: string | null,
    durationS: number, hadConversation: boolean,
  ): Promise<void> {
    const callerLabel = init.caller_name || init.caller_phone || "Unknown caller";
    const conv = init.caller_uid
      ? dmConvId(init.owner_uid, init.caller_uid)
      : (init.caller_phone
          ? `recept_${init.owner_uid}__tel:${init.caller_phone}`
          : `recept_${init.owner_uid}__unknown`);
    const inThread = !!init.caller_uid;
    const bodyText = summary
      ? `📞 ${summary.caller_name || callerLabel} called and left a message: ${summary.reason}`
      : hadConversation
        ? `📞 ${callerLabel} called — Ava answered.`
        : `📞 Missed call from ${callerLabel} — they hung up before leaving a message.`;
    const envelope = JSON.stringify({
      t: "recept",
      text: bodyText,
      session_id: init.sid,
      caller_name: init.caller_name, caller_phone: init.caller_phone,
      call_id: init.call_id, duration_s: durationS,
      activation_mode: init.activation_mode,
      summary, transcript, has_recording: !!recordingUrl,
    });
    const payload = {
      conv,
      sender: init.caller_uid || `tel:${init.caller_phone}`,
      kind: "receptionist",
      body: envelope,
      media_ref: recordingUrl,
      scope: `to:${init.owner_uid}`,
      created_at: Date.now(),
    };
    const stub = this.env.INBOX.get(this.env.INBOX.idFromName(init.owner_uid));
    await stub.fetch("https://inbox/append", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, owner: init.owner_uid }),
    });
    try {
      await this.env.Q_PUSH.send({
        kind: "notify", to: init.owner_uid, fromName: "Ava",
        title: "Ava took a message", body: bodyText.replace(/^📞\s*/, ""),
        data: { type: "receptionist", conv, caller_phone: init.caller_phone },
      });
      this.ev("ava_recept_push_sent", { ok: true });
    } catch (e) {
      this.ev("ava_recept_delivery_failed", { stage: "push", error_scrubbed: scrubSecrets(String(e)).slice(0, 200) });
    }
    this.ev("ava_recept_delivered_inthread", {
      in_thread: inThread, conv_kind: inThread ? "dm" : "recept_fallback",
      has_recording: !!recordingUrl,
    });

    // Caller-side ack: only when the cell caller resolved to an AvaTOK user.
    if (init.caller_uid && init.caller_uid !== init.owner_uid && hadConversation) {
      const ownerLabel = (init.owner_name || "your contact").trim();
      const greet = init.caller_name ? `Hi ${init.caller_name}` : "Hi there";
      const ackText = `${greet} — this is ${ownerLabel}'s assistant. I've taken your message and ${ownerLabel} will get back to you soon.`;
      try {
        const ackStub = this.env.INBOX.get(this.env.INBOX.idFromName(init.caller_uid));
        await ackStub.fetch("https://inbox/append", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conv,
            sender: init.owner_uid,
            kind: "text",
            body: JSON.stringify({ t: "text", body: ackText }),
            scope: `to:${init.caller_uid}`,
            created_at: Date.now(),
            owner: init.caller_uid,
          }),
        });
        await this.env.Q_PUSH.send({ kind: "notify", to: init.caller_uid, fromName: ownerLabel });
        this.ev("ava_recept_caller_ack_sent", { ok: true });
      } catch (e) {
        this.ev("ava_recept_caller_ack_sent", { ok: false, error_scrubbed: scrubSecrets(String(e)).slice(0, 200) });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// helpers (mirrors reception_room.ts)
// ---------------------------------------------------------------------------
function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True when a caller PCM16 frame carries real speech (RMS above a silence
 *  floor) — gates the 2-way recording + idle/nudge bookkeeping. */
function callerHasSpeech(pcm: Uint8Array): boolean {
  const n = pcm.byteLength >> 1;
  if (n === 0) return false;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sumSq = 0;
  for (let i = 0; i < n; i++) { const s = view.getInt16(i * 2, true); sumSq += s * s; }
  return Math.sqrt(sumSq / n) > 600;
}

/** Upsample mono PCM16 16kHz → 24kHz (linear, 3:2) for the merged recording. */
function upsample16to24(pcm16: Uint8Array, gain = 1): Uint8Array {
  const inN = pcm16.byteLength >> 1;
  if (inN === 0) return new Uint8Array(0);
  const inView = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  const outN = Math.floor((inN * 3) / 2);
  const out = new Uint8Array(outN * 2);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < outN; i++) {
    const srcPos = (i * 2) / 3;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, inN - 1);
    const frac = srcPos - i0;
    const s0 = inView.getInt16(i0 * 2, true);
    const s1 = inView.getInt16(i1 * 2, true);
    let v = Math.round((s0 + (s1 - s0) * frac) * gain);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    outView.setInt16(i * 2, v, true);
  }
  return out;
}

/** Peak absolute PCM16 sample value (adaptive normalization). */
function peakOf(pcm: Uint8Array): number {
  const n = pcm.byteLength >> 1;
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let pk = 0;
  for (let i = 0; i < n; i++) { const s = Math.abs(v.getInt16(i * 2, true)); if (s > pk) pk = s; }
  return pk;
}

/** Wrap tagged PCM16/24k mono segments in a minimal WAV, applying [callerGain]
 *  to caller segments only (per-call loudness normalization, clipped). */
function pcm16ToWav(
  segments: Array<{ caller: boolean; pcm: Uint8Array }>,
  dataLen: number, sampleRate: number, callerGain = 1,
): Uint8Array {
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const wr = (off: number, str: string) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
  wr(0, "RIFF"); dv.setUint32(4, 36 + dataLen, true); wr(8, "WAVE");
  wr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, "data"); dv.setUint32(40, dataLen, true);
  let off = 44;
  for (const seg of segments) {
    if (seg.caller && callerGain !== 1) {
      const n = seg.pcm.byteLength >> 1;
      const sv = new DataView(seg.pcm.buffer, seg.pcm.byteOffset, seg.pcm.byteLength);
      for (let i = 0; i < n; i++) {
        let v = Math.round(sv.getInt16(i * 2, true) * callerGain);
        if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
        dv.setInt16(off + i * 2, v, true);
      }
      off += seg.pcm.byteLength;
    } else {
      out.set(seg.pcm, off); off += seg.pcm.byteLength;
    }
  }
  return out;
}
