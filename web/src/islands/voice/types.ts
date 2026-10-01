/* [AUMFE-VOICE-WEB-1] Web-side copy of the voice wire protocol.
 * Source of truth: worker/src/lib/voice_agents/types.ts (do not import worker code into web).
 * Keep in step by hand; change only with the coordinator's agreement. */

export interface VoiceAgentPublic { id: string; name: string; subject: string; initial: string; tint: string; blurb: string }

export interface VoiceCard { title: string; items: { label: string; value: string }[] }

export type ClientMsg =
  | { type: 'start' }
  | { type: 'mute'; on: boolean }
  | { type: 'text'; text: string }
  | { type: 'image'; mime: 'image/jpeg' | 'image/png'; data_b64: string }
  | { type: 'end' };

export type ServerMsg =
  | { type: 'ready'; session_id: string; agent: VoiceAgentPublic; remembers: string[]; max_seconds: number;
      free_seconds: number; price_per_min_paise: number; billing: 'test' | 'live' }
  | { type: 'agent_state'; state: 'connecting' | 'listening' | 'thinking' | 'speaking' }
  | { type: 'caption'; who: 'user' | 'agent'; text: string; final: boolean }
  | { type: 'interrupted' }
  | { type: 'tool'; name: string; status: 'start' | 'done' | 'error'; card?: VoiceCard }
  | { type: 'meter'; seconds: number; cost_paise: number; remaining_seconds: number }
  | { type: 'ending_soon'; remaining_seconds: number }
  | { type: 'ended'; reason: 'customer' | 'time_up' | 'error' | 'idle' | 'server'; session_id: string }
  | { type: 'error'; code: string; message: string };

export type AgentState = 'connecting' | 'listening' | 'thinking' | 'speaking';

/** GET /api/voice/agents — assumed shape; every pricing field is optional and read tolerantly. */
export interface AgentsResponse {
  agents?: (VoiceAgentPublic & { price_per_min_paise?: number; free_seconds?: number })[];
  can_use?: boolean;
  price_per_min_paise?: number;
  free_seconds?: number;
}

export interface TicketResponse { ticket: string; ws_url: string; agent: VoiceAgentPublic }

/** GET /api/me/astro-profile */
export interface AstroProfile {
  name: string | null; gender: string | null; dob: string | null; tob: string | null; tob_unknown: boolean;
  place: string | null; memory_consent: boolean; consent_at: number | null;
}

export interface AgentSessionRow {
  id: string; agent: string; channel: 'voice' | 'chat'; started_at: number; ended_at: number | null;
  minutes: number | null; cost_paise: number | null; summary: string | null; status: string;
}

export interface MemoryItem { id: string; agent: string; kind: string; text: string; created_at: number }
