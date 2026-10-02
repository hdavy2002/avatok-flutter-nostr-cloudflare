// [AUMFE-CONSULT-FOUNDATION-1 2026-10-02] Real Consultants — the ONE shared contract (rows, DTOs, enums).
// Spec: Specs/SPEC-2026-10-02-REAL-CONSULTANTS-BUILD.md. Web mirror: web/src/lib/consultTypes.ts (keep in step;
// the two files must stay byte-identical below the header — `python3 tool/check_consult_types.py` checks it).
//
// Money is in RUPEES (integers). 1 wallet token = ₹1. GST is ADDED on top of the consultant's rate; the platform fee is
// 20% OF THE RATE; the consultant's wallet receives rate − fee (owner decision 2026-10-02: ₹1,000 rate → ₹800).

export const DISCIPLINES = ["astrology", "numerology", "palmistry", "face_reading", "tarot"] as const;
export type Discipline = (typeof DISCIPLINES)[number];

export const DISCIPLINE_LABEL: Record<Discipline, { en: string; hi: string }> = {
  astrology: { en: "Vedic astrology", hi: "ज्योतिष" },
  numerology: { en: "Numerology", hi: "अंक शास्त्र" },
  palmistry: { en: "Palmistry", hi: "हस्तरेखा" },
  face_reading: { en: "Face reading", hi: "मुख सामुद्रिक" },
  tarot: { en: "Tarot", hi: "पत्ते" },
};

export type ConsultantStatus = "draft" | "live" | "paused";
export type BookingStatus =
  | "held"            // slot held, waiting for payment (expires_at)
  | "awaiting_review" // customer says paid; admin/SMS match pending
  | "confirmed"       // paid; file being prepared / ready
  | "in_call"
  | "completed"       // settled to wallets
  | "no_show_consultant" // refunded (manual) + strike
  | "no_show_customer"   // consultant paid
  | "cancelled"
  | "expired";
export type PrepStatus = "pending" | "running" | "ready" | "partial" | "failed";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type PhotoKind = "palm_right" | "palm_left" | "face_front" | "face_side";

// ---------- intake (what the customer fills, per discipline) ----------
export interface BirthBlock {
  name: string; gender: "male" | "female" | "other"; dob: string; // YYYY-MM-DD
  tob: string | null; tob_unknown: boolean;                          // HH:MM 24h
  place: string; lat: number | null; lon: number | null; tzone: number | null;
}
export interface AstrologyIntake { kind: "astrology"; birth: BirthBlock; gotra?: string; marital_status?: string; current_city?: string; focus: string[]; partner?: BirthBlock | null }
export interface NumerologyIntake { kind: "numerology"; birth_name: string; used_name?: string; dob: string; mobile?: string; names_to_check?: string[] }
export interface PalmistryIntake { kind: "palmistry"; dominant_hand: "right" | "left"; age?: number; gender?: string; occupation?: string; focus: string[] }
export interface FaceIntake { kind: "face_reading"; gender?: string; dob?: string | null; focus: string[] }
export interface TarotIntake { kind: "tarot"; name: string; dob?: string | null; question: string; cards: { love: number; career: number; finance: number }; reversed?: { love?: boolean; career?: boolean; finance?: boolean }; yes_no?: { question: string; card: number } | null }
export type Intake = AstrologyIntake | NumerologyIntake | PalmistryIntake | FaceIntake | TarotIntake;

// ---------- prepared file (cards the consultant sees and may edit) ----------
// Card keys per discipline (prepare lane writes exactly these; desk UI renders by key, unknown keys as JSON).
export const CARD_KEYS: Record<Discipline, string[]> = {
  astrology: ["birth_details", "chart_d1", "chart_d9", "planets", "dasha", "doshas", "panchang", "remedies", "match"],
  numerology: ["core_numbers", "lo_shu", "names", "lucky", "report", "daily"],
  palmistry: ["palm_photos", "hand_type", "lines", "mounts", "readings"],
  face_reading: ["face_photos", "features", "readings"],
  tarot: ["spread", "readings", "yes_no"],
};
export interface FileCard { key: string; title: string; api: unknown; override: unknown | null; edited_by: string | null; edited_at: number | null; status: "ok" | "missing" | "error"; note?: string }

// ---------- money ----------
export interface PriceBreakdown { rate: number; gst: number; total: number; fee: number; payout: number; gst_rate_pct: number; fee_rate_pct: number }

// ---------- DTOs ----------
export interface ConsultantCard {
  id: string; slug: string; name: string; disciplines: Discipline[]; photo_url: string; photo_hero_url: string;
  years: number | null; languages: string[]; city: string | null; tagline: string | null;
  slot_minutes: number; price: PriceBreakdown; rating_avg: number | null; rating_count: number; next_free_ms: number | null; status: ConsultantStatus;
}
export interface ConsultantDetail extends ConsultantCard { bio: string | null; lineage: string | null; covers: string[] }
export interface ReviewDTO { id: string; stars: number; text: string | null; display_name: string; discipline: Discipline; created_at: number }
export interface SlotDay { date: string; slots: { start_ms: number; label: string }[] }
export interface BookingDTO {
  id: string; ref: string; consultant: Pick<ConsultantCard, "slug" | "name" | "photo_url">; discipline: Discipline;
  slot_start_ms: number; slot_end_ms: number; status: BookingStatus; price: PriceBreakdown; questions: string[];
  prep_status: PrepStatus; join_opens_ms: number; expires_at: number | null; created_at: number;
}
export interface DeskBookingDTO extends BookingDTO { customer: { uid: string; name: string; city: string | null; age: number | null; repeat: boolean } }
export interface DeskFileDTO { booking: DeskBookingDTO; intake: Intake; cards: FileCard[]; notes: string; past_notes: { booking_id: string; at: number; note: string }[]; photos: { kind: PhotoKind; url: string }[] }
export interface CallTicketDTO { ticket: string; ws_url: string; role: "customer" | "consultant"; ice_servers: RTCIceServerLike[]; slot_end_ms: number }
export interface RTCIceServerLike { urls: string | string[]; username?: string; credential?: string }

// ---------- call signalling (ConsultCallDO WebSocket, JSON per frame) ----------
export type CallClientMsg =
  | { t: "hello" } | { t: "offer"; sdp: string } | { t: "answer"; sdp: string } | { t: "ice"; candidate: unknown }
  | { t: "end" } | { t: "reveal"; card: { id: number; reversed: boolean; position: string } } | { t: "ping" };
export type CallServerMsg =
  | { t: "state"; me: "customer" | "consultant"; other_present: boolean; started_at: number | null; slot_end_ms: number; you_offer: boolean }
  | { t: "offer"; sdp: string } | { t: "answer"; sdp: string } | { t: "ice"; candidate: unknown }
  | { t: "peer_left" } | { t: "ended"; reason: "ended_by_consultant" | "slot_over" | "admin" } | { t: "reveal"; card: { id: number; reversed: boolean; position: string } }
  | { t: "pong" } | { t: "error"; error: string };
