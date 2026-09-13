// [AGENT-LIVE-1] OpenAI GPT-Live-1 wire protocol — event builders + parsers.
// Owned by WS-E1. Mirrors Specs/codex-rounds/round2-astra.md ("R2") §3.4-§3.8
// exactly (event shapes, event ids, delegation contract). D3/D9/D12 constants
// mirror Specs/SPEC-2026-09-12-AGENT-LIVE-1-BUILD.md ("BUILD SPEC").
//
// Transport: `wss://api.openai.com/v1/live/sessions`, no model query param
// (BUILD SPEC D3, R2 §3.3). Connect the same way agent_voice_room.ts connects
// to Grok's realtime endpoint: `fetch(url, {headers:{Upgrade:"websocket",
// Authorization:"Bearer <key>"}})`, then `.webSocket!.accept()`.
export const OPENAI_LIVE_URL = "wss://api.openai.com/v1/live/sessions";

// ---------------------------------------------------------------------------
// Function tool schemas — verbatim from R2 §3.4. Used only inside
// `session.start`'s `delegation.responses.tools`; never as a hosted tool.
// ---------------------------------------------------------------------------
export const AGENT_LIVE_TOOL_DEFS: readonly Record<string, unknown>[] = [
  {
    type: "function",
    name: "search_knowledge",
    description: "Search this agent's approved knowledge base.",
    strict: true,
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "remember_fact",
    description: "Remember a bounded fact explicitly stated by this customer.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        fact: { type: "string" },
        source_start_ms: { type: "integer" },
        source_end_ms: { type: "integer" },
      },
      required: ["fact", "source_start_ms", "source_end_ms"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_customer_time",
    description: "Get authoritative current time in the customer's chosen timezone.",
    strict: true,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    type: "function",
    name: "describe_shared_image",
    description: "Read an existing analysis of an image shared in this session.",
    strict: true,
    parameters: {
      type: "object",
      properties: { image_id: { type: ["string", "null"] } },
      required: ["image_id"],
      additionalProperties: false,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Outbound event builders (Room -> OpenAI)
// ---------------------------------------------------------------------------

export interface SessionStartParams {
  bookingId: string;
  sessionGeneration: number;
  liveModel: string; // agent.live_model, default 'gpt-live-1'
  voice: string;
  frontendPrompt: string;
  backendModel: string; // agent.backend_model, default 'gpt-6-astra'
  backendPrompt: string;
  maxOutputTokens?: number;
}

/** Exact `session.start` shape — R2 §3.4. */
export function sessionStartEvent(p: SessionStartParams): Record<string, unknown> {
  return {
    type: "session.start",
    event_id: `start:${p.bookingId}:${p.sessionGeneration}`,
    session: {
      model: p.liveModel,
      audio: {
        format: { type: "audio/pcm", rate: 24000 },
        output: { voice: p.voice },
      },
      instructions: p.frontendPrompt,
      delegation: {
        type: "responses",
        responses: {
          model: p.backendModel,
          instructions: p.backendPrompt,
          max_output_tokens: p.maxOutputTokens ?? 2048,
          tools: AGENT_LIVE_TOOL_DEFS,
        },
      },
    },
  };
}

/** Time / memory refresh — R2 §3.5. Send the FULL recomposed backend prompt;
 * omitted delegation settings retain their previous value. */
export function sessionUpdateInstructionsEvent(
  sessionGeneration: number,
  timeRevision: number,
  backendPrompt: string,
): Record<string, unknown> {
  return {
    type: "session.update",
    event_id: `time:${sessionGeneration}:${timeRevision}`,
    session: {
      delegation: { type: "responses", responses: { instructions: backendPrompt } },
    },
  };
}

/** Photo side-channel — R2 §3.6. Never followed by `response.create`. */
export function commentaryAppendEvent(
  imageId: string,
  sessionGeneration: number,
  content: string,
): Record<string, unknown> {
  return {
    type: "session.commentary.append",
    event_id: `image:${imageId}:${sessionGeneration}`,
    delegation_id: null,
    content,
  };
}

/** Wrap-up nudge at `ends_at - 60s` — appended as regular voice-layer
 * instructions (not a delegation instruction, so it doesn't fight the time
 * refresh above); speakable immediately without a function round-trip. */
export function wrapUpInstructionsEvent(sessionGeneration: number): Record<string, unknown> {
  return {
    type: "session.instructions.append",
    event_id: `wrapup:${sessionGeneration}`,
    // F10: `delegation_id` is required-nullable on every `*.append` per the
    // Live reference, same as commentary/thinking appends.
    delegation_id: null,
    content:
      "You have about one minute left in this session. Begin wrapping up warmly now; do not start any new topic.",
  };
}

/** Function-call result — R2 §3.7. */
export function functionCallOutputEvent(callId: string, output: unknown): Record<string, unknown> {
  return {
    type: "response.item.create",
    event_id: `tool-result:${callId}`,
    item: {
      type: "function_call_output",
      call_id: callId,
      output: typeof output === "string" ? output : JSON.stringify(output),
    },
  };
}

/** Continue backend work after ALL required results for a response have been
 * supplied. No body, no `delegation_id` (R2 §3.7). */
export function responseCreateEvent(responseId: string): Record<string, unknown> {
  return { type: "response.create", event_id: `continue:${responseId}` };
}

/** Graceful close — R2 §3.8. */
export function sessionCloseEvent(sessionGeneration: number): Record<string, unknown> {
  return { type: "session.close", event_id: `close:${sessionGeneration}` };
}

// ---------------------------------------------------------------------------
// Inbound event parsing (OpenAI -> Room)
// ---------------------------------------------------------------------------

export interface ParsedFunctionCall {
  responseId: string | null;
  delegationId: string | null;
  callId: string;
  name: string;
  argsRaw: string;
}

export interface ParsedTranscriptDelta {
  speaker: "customer" | "agent";
  delta: string;
  providerEventId: string;
  startMs: number;
  endMs: number;
}

export type ParsedProviderEvent =
  | { kind: "session.started"; providerSessionId: string | null; raw: any }
  | { kind: "session.updated"; raw: any }
  | { kind: "session.closed"; usage: unknown; raw: any }
  | { kind: "session.commentary.appended"; eventId: string | null; raw: any }
  | { kind: "audio.delta"; base64: string }
  | { kind: "transcript.delta"; delta: ParsedTranscriptDelta }
  | { kind: "function_call"; call: ParsedFunctionCall }
  | { kind: "response.created"; responseId: string | null; delegationId: string | null }
  // F11: the nested terminal event for one delegation response — fired once
  // all of that response's output items (including any function_call items)
  // have been emitted. Used to know it is safe to send `response.create`.
  | { kind: "response.terminal"; responseId: string | null }
  | { kind: "error"; code: string | null; message: string; raw: any }
  | { kind: "other"; type: string; raw: any };

/** Parse one raw OpenAI Live JSON control message into a discriminated union.
 * Defensive: never throws; unknown/malformed shapes fall through to `other`
 * or are swallowed by the caller's try/catch around JSON.parse. */
export function parseProviderEvent(m: any): ParsedProviderEvent {
  const type = String(m?.type || "");

  if (type === "session.started") {
    return { kind: "session.started", providerSessionId: m?.session?.id ?? m?.session_id ?? null, raw: m };
  }
  if (type === "session.updated") return { kind: "session.updated", raw: m };
  if (type === "session.closed") return { kind: "session.closed", usage: m?.usage ?? null, raw: m };
  if (type === "session.commentary.appended") {
    return { kind: "session.commentary.appended", eventId: m?.event_id ?? null, raw: m };
  }
  if (type === "session.output_audio.delta" && typeof m?.delta === "string") {
    return { kind: "audio.delta", base64: m.delta };
  }
  if (type === "session.output_transcript.delta" && typeof m?.delta === "string") {
    return {
      kind: "transcript.delta",
      delta: {
        speaker: "agent",
        delta: m.delta,
        providerEventId: String(m?.event_id ?? crypto.randomUUID()),
        startMs: Number(m?.start_ms ?? m?.item_start_ms ?? 0),
        endMs: Number(m?.end_ms ?? m?.item_end_ms ?? 0),
      },
    };
  }
  if (type === "session.input_transcript.delta" && typeof m?.delta === "string") {
    return {
      kind: "transcript.delta",
      delta: {
        speaker: "customer",
        delta: m.delta,
        providerEventId: String(m?.event_id ?? crypto.randomUUID()),
        startMs: Number(m?.start_ms ?? m?.item_start_ms ?? 0),
        endMs: Number(m?.end_ms ?? m?.item_end_ms ?? 0),
      },
    };
  }
  if (type === "response.event") {
    const inner = m?.event ?? {};
    const innerType = String(inner?.type || "");
    if (innerType === "response.created") {
      return {
        kind: "response.created",
        responseId: inner?.response?.id ?? null,
        delegationId: m?.delegation_id ?? null,
      };
    }
    if (innerType === "response.output_item.done" && inner?.item?.type === "function_call") {
      const item = inner.item;
      return {
        kind: "function_call",
        call: {
          responseId: inner?.response_id ?? inner?.response?.id ?? null,
          delegationId: m?.delegation_id ?? null,
          callId: String(item?.call_id ?? ""),
          name: String(item?.name ?? ""),
          argsRaw: String(item?.arguments ?? "{}"),
        },
      };
    }
    // F11: response terminal marker — everything for this response has been
    // emitted, so it is now safe to `response.create` once our own function
    // outputs for it are all supplied.
    if (innerType === "response.completed" || innerType === "response.done") {
      return { kind: "response.terminal", responseId: inner?.response?.id ?? inner?.response_id ?? null };
    }
    // F6: a delegation-side failure nested inside response.event must count
    // as a provider/backend error for no-show evidence and settlement —
    // OpenAI does not always surface these as a top-level `error` event.
    if (
      innerType === "response.failed" ||
      inner?.response?.status === "failed" ||
      inner?.item?.type === "error"
    ) {
      const errObj = inner?.response?.error ?? inner?.item?.error ?? inner?.error ?? {};
      return {
        kind: "error",
        code: (errObj as any)?.code ?? (innerType || "delegation_failed"),
        message: String((errObj as any)?.message ?? "delegation_failed"),
        raw: m,
      };
    }
    return { kind: "other", type: `response.event:${innerType}`, raw: m };
  }
  if (type === "error") {
    const err = m?.error ?? m;
    return {
      kind: "error",
      code: err?.code ?? null,
      message: String(err?.message ?? "unknown_error"),
      raw: m,
    };
  }
  return { kind: "other", type, raw: m };
}
