/* [AUMFE-PANDIT-WEB-1] Wire types for /pandit. Contract: GET /api/guides/pandit/state and POST /api/guides/pandit/chat
 * (SSE), built by the guide-brain worker. Keep in step with worker/src/guides — do not widen without the worker. */

export interface WhyStep { step: 'deity' | 'chakra' | 'print_colour' | 'shirt_colour'; fact: string }

export interface Card {
  kind: 'product' | 'puja';
  subject_id: string;
  title: string;
  price_inr: number;
  image_url: string;
  url: string;
  wear_days: string[];
  deity: string;
  chakra: string;
  tradition_note: string;
  why: WhyStep[];
}

export interface PanditProfile {
  name: string | null; dob: string | null; tob: string | null; tob_unknown: boolean; place: string | null; gender: string | null;
}

export interface PanditChart { lagna: string; moon_sign: string; nakshatra: string; dasha: string; doshas: string[] }

export interface PanditMemory { id: string; text: string }

export interface PanditMessage { role: 'user' | 'assistant'; text: string; cards?: Card[] }

export interface PanditState {
  enabled: boolean;
  can_use: boolean;
  needs_phone: boolean;
  profile: PanditProfile | null;
  consent: boolean;
  chart: PanditChart | null;
  memories: PanditMemory[];
  conversation: { id: string; messages: PanditMessage[] } | null;
}

export type PanditStreamEvent =
  | { type: 'meta'; conversation_id: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'card'; card: Card }
  | { type: 'done' }
  | { type: 'error'; code: string; message: string };

/** What the birth-details form sends to PUT /api/me/astro-profile (worker lib/agent_memory.upsertProfile). */
export interface ProfileInput {
  name: string; dob: string; tob: string | null; tob_unknown: boolean; place: string;
}
