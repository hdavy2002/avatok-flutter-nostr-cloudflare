// [AUMFE-VOICE-CONTRACT-1 2026-10-01] Shared contract for the voice guides (Gemini Live).
// Three lanes build against this file at the same time:
//   - runtime (VoiceSession DO + routes)        -> worker/src/do/voice_session.ts, worker/src/routes/voice.ts
//   - subject agents (Astrology first)          -> worker/src/lib/voice_agents/agents/*.ts
//   - web call screen                           -> web/ (talks the wire protocol below)
// Change this file only with the coordinator's agreement. Spec: Specs/SPEC-2026-10-01-VOICE-AGENTS.md
import type { Env } from "../../types";

// ---------------------------------------------------------------------------
// Agents and tools (runtime <-> subject agents)
// ---------------------------------------------------------------------------

/** What a tool sees when the model calls it. uid is the VERIFIED caller; never take a uid from model args. */
export interface VoiceToolCtx {
  env: Env;
  uid: string;
  sessionId: string;
  agentId: string;
  /** Send a card to the call screen (e.g. "Looked up your chart"). Optional, best-effort. */
  showCard?: (card: VoiceCard) => void;
}

/** Gemini functionDeclarations shape (OpenAPI subset, UPPERCASE types). */
export interface VoiceFunctionDecl {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface VoiceTool {
  decl: VoiceFunctionDecl;
  /** Return plain JSON for the model. Never throw: return { error } instead. Keep results small (< ~4 KB). */
  run(ctx: VoiceToolCtx, args: Record<string, unknown>): Promise<unknown>;
  /** true (default false) = the model waits for the result; false = NON_BLOCKING, she keeps talking. */
  blocking?: boolean;
}

export interface VoiceAgentDef {
  /** Stable id used in URLs and D1 (agent_sessions.agent): "astrology", "palmistry", ... */
  id: string;
  /** Persona name shown and spoken, e.g. "Meera". */
  name: string;
  /** Subject label, e.g. "Astrology". */
  subject: string;
  /** Gemini prebuilt voice name. */
  voice: string;
  /** Default language hint, e.g. "hi-IN"; the model still follows the customer's language. */
  language: string;
  /** Builds the system instruction. `briefing` comes from agent_memory.buildBriefing (may be ""). */
  systemPrompt(input: { briefing: string; brandName: string; nowIst: string }): string;
  /** Agent-specific tools. The runtime adds the shared memory tools (remember, recall) itself. */
  tools: VoiceTool[];
  /** Tiny avatar letter/tint for the UI until real art exists. */
  ui: { initial: string; tint: string; blurb: string };
  // [AUMFE-VOICE-AGENTS-DB-1] Set for agents loaded from D1 (voice_agents). Absent on the code fallback.
  /** Owner price in wallet tokens per started minute. undefined = use config voiceAgentPricePerMinPaise; 0 = free. */
  pricePerMinTokens?: number;
  avatarUrl?: string | null;
  status?: "draft" | "preview" | "live" | "archived";
}

// ---------------------------------------------------------------------------
// Wire protocol (browser <-> VoiceSession DO)
// ---------------------------------------------------------------------------
// 1. Browser: POST /api/voice/ticket {agent} with the normal Clerk auth header
//    -> { ticket, ws_url, agent: VoiceAgentPublic }   (ticket: single use, 60 s, KV TOKENS)
// 2. Browser opens WebSocket ws_url (?ticket=...). Binary frames = audio.
//    Browser -> server binary: PCM16 little-endian, mono, 16 kHz, ~20-100 ms chunks.
//    Server -> browser binary: PCM16 little-endian, mono, 24 kHz.

export interface VoiceAgentPublic {
  id: string; name: string; subject: string; initial: string; tint: string; blurb: string;
  // [AUMFE-VOICE-AGENTS-DB-1] additive: the guide card price + picture (price null = use the platform default price).
  price_per_min_tokens?: number | null; avatar_url?: string | null;
}

export interface VoiceCard { title: string; items: { label: string; value: string }[] }

export type ClientMsg =
  | { type: "start" }                                   // after mic is ready
  | { type: "mute"; on: boolean }
  | { type: "text"; text: string }                      // typed message (accessibility / fallback)
  | { type: "image"; mime: "image/jpeg" | "image/png"; data_b64: string } // palm/face snapshot (later agents)
  | { type: "end" };

export type ServerMsg =
  | { type: "ready"; session_id: string; agent: VoiceAgentPublic; remembers: string[]; max_seconds: number;
      free_seconds: number; price_per_min_paise: number; billing: "test" | "live" }
  | { type: "agent_state"; state: "connecting" | "listening" | "thinking" | "speaking" }
  | { type: "caption"; who: "user" | "agent"; text: string; final: boolean }
  | { type: "interrupted" }                             // customer spoke over her: browser drops queued audio
  | { type: "tool"; name: string; status: "start" | "done" | "error"; card?: VoiceCard }
  | { type: "meter"; seconds: number; cost_paise: number; remaining_seconds: number }
  | { type: "ending_soon"; remaining_seconds: number }
  | { type: "ended"; reason: "customer" | "time_up" | "balance_out" | "error" | "idle" | "server"; session_id: string }
  | { type: "error"; code: string; message: string };
