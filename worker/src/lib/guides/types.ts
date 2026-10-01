// [AUMFE-GUIDE-BRAIN-1 2026-10-01] Shared types for the guide brain (Meera by voice, Pandit ji by text).
import type { VoiceToolCtx } from "../voice_agents/types";

/** What the web renders under a Pandit ji reply. Contract with the web lanes: do not change field names. */
export interface GuideCard {
  kind: "product" | "puja";
  subject_id: string;
  title: string;
  price_inr: number | null;
  image_url: string | null;
  url: string;
  wear_days: string[];
  deity: string | null;
  chakra: string | null;
  tradition_note: string;
  why: { step: "deity" | "chakra" | "print_colour" | "shirt_colour"; fact: string }[];
}

/** The voice tool context plus an optional channel for structured product/puja cards (text chat -> SSE `card`). */
export interface GuideToolCtx extends VoiceToolCtx {
  showGuideCard?: (card: GuideCard) => void;
}

/** Wire events of POST /api/guides/pandit/chat (one JSON per `data:` line). */
export type ChatEvent =
  | { type: "meta"; conversation_id: string }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string }
  | { type: "card"; card: GuideCard }
  | { type: "done" }
  | { type: "error"; code: string; message: string };

export interface ChatMessageOut {
  role: "user" | "assistant";
  text: string;
  cards?: GuideCard[];
}
