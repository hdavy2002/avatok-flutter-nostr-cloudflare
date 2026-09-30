// [SAATHUM-PREETI-1 2026-09-30] Web mirror of the Preeti wire types in
// worker/src/lib/preeti/contracts.ts (copied verbatim - keep both in step).

export type PageKind = "home" | "article" | "event" | "other";
export interface PageCtx { path: string; kind: PageKind; ref?: string } // ref = ritual slug or listing id

export interface PreetiPublicConfig {
  enabled: boolean;
  agent_name: string;
  avatar_url: string | null;
  welcome_text: string;          // placeholders already filled
  quick_replies: { home: string[]; article: string[]; event: string[] };
  support_whatsapp_e164: string; // "+919259457189"
  brand_name: string;
  brand_domain: string;
  over_budget: boolean;          // true -> widget shows "please WhatsApp us" mode
}

export interface PreetiMessageOut {
  id: number;
  role: "visitor" | "preeti";
  text: string;
  cards: PreetiCard[];
  at: number;
}

export interface PreetiSession {
  conversation_id: string;
  needs_identity: boolean;       // anonymous + no name/e164 yet
  name: string | null;
  history: PreetiMessageOut[];   // last 30, oldest first
}

export type PreetiCard =
  | { type: "event"; id: string; title: string; image: string | null; starts_at_ms: number | null;
      price_rupees: number | null; live_now: boolean; booking_open: boolean; read_more_url: string; book_url: string }
  | { type: "article"; slug: string; title: string; image: string | null; url: string };

export type PreetiStreamEvent =
  | { type: "delta"; text: string }
  | { type: "card"; card: PreetiCard }
  | { type: "handover"; url: string }
  | { type: "done"; message_id: number }
  | { type: "error"; code: string; message: string };
// Wire format: SSE, one `data: <json PreetiStreamEvent>\n\n` per event.

