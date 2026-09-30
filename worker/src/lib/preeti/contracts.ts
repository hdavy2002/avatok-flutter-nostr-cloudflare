// [SAATHUM-PREETI-1 2026-09-30] Shared wire + module contracts for Preeti, the site AI agent.
// Spec: Specs/SPEC-2026-09-30-PREETI-AI-AGENT.md. The web mirrors these shapes in
// web/src/lib/preetiTypes.ts (keep both in step). Coordinator-owned: change only with a note.

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
  needs_signin?: boolean;        // [SAATHUM-PREETI-SIGNIN-1] true -> not signed in with a verified WhatsApp; chat is refused
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
  | { type: "error"; code: string; message: string }
  // [SAATHUM-PREETI-LEADGATE-1]
  | { type: "identity_required" }                        // anonymous visitor must share email + WhatsApp before Preeti answers
  | { type: "session"; conversation_id: string };        // server created the conversation on the first message
// Wire format: SSE, one `data: <json PreetiStreamEvent>\n\n` per event.

export interface BrandRuntime {
  name: string; domain: string; site: string;          // site = https origin
  former: { name: string; domain: string | null }[];
}

export interface KnowledgeSyncResult { scanned: number; uploaded: number; unchanged: number; removed: number; failed: number }

// ---- Admin wire shapes ----
export interface AdminAiConfig {
  name: string; avatar_url: string | null; welcome_text: string;
  quick_replies: { home: string[]; article: string[]; event: string[] };
  support_whatsapp: string; alert_whatsapp: string; enabled: boolean;
  monthly_cap_rupees: number; active_prompt_id: string | null; flag_enabled: boolean;
}
export interface AdminAiPrompt { id: string; body: string; note: string | null; created_by: string; created_at: number; published_at: number | null; active: boolean }
export interface AdminAiFile { id: string; file_name: string; mime: string; size_bytes: number; status: string; error: string | null; created_at: number }
export interface AdminAiKnowledgeDoc { url: string; kind: "article" | "page"; title: string | null; status: string; synced_at: number | null; error: string | null }
export interface AdminAiIncident { id: string; listing_id: string | null; listing_title: string | null; message: string; starts_at: number; expires_at: number | null; source: string; created_at: number }
export interface AdminAiConversationRow {
  id: string; name: string | null; e164: string | null; email: string | null; uid: string | null; visitor_label: string;
  last_text: string; last_message_at: number; badges: string[]; status: "open" | "resolved" | "needs_human"; lead_score: number; message_count: number;
}
export interface AdminAiMessage { id: number; role: "visitor" | "preeti" | "tool" | "admin_note" | "system"; text: string; cards: PreetiCard[]; tool_name: string | null; tool_summary: string | null; blocked: boolean; created_at: number }
export interface AdminAiConversationDetail { conversation: AdminAiConversationRow & { first_page: string | null; last_page: string | null; admin_note: string | null }; messages: AdminAiMessage[]; bookings: { checkout_id: string; listing_title: string; status: string; created_at: number }[] }
export interface AdminAiBrand { current: BrandRuntime; checklist: string[] }
export interface AdminAiBrandChangeResult { ok: boolean; error?: string; check: { question: string; answer: string; pass: boolean }[] }
export interface AdminAiSpend { month: string; cost_rupees: number; cap_rupees: number; pct: number; messages: number; conversations: number }
