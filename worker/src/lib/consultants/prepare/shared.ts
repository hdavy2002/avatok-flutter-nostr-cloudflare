// [AUMFE-CONSULT-W2-1 2026-10-02] Shared bits for the per-discipline card builders.
import type { Env } from "../../../types";
import type { Discipline } from "../types";
import { CARD_KEYS } from "../types";

/** What a builder produces for one card. `na` = the card does not apply to this booking (kept ok, not counted as missing). */
export interface CardOut { key: string; title: string; api: unknown; status: "ok" | "missing" | "error"; note?: string }
export interface PrepCtx { env: Env; bookingId: string; uid: string }

export const CARD_TITLES: Record<string, string> = {
  birth_details: "Birth details", chart_d1: "Birth chart (D1)", chart_d9: "Navamsha chart (D9)", planets: "Planet positions",
  dasha: "Dasha periods", doshas: "Doshas", panchang: "Panchang at birth", remedies: "Remedies", match: "Kundli matching",
  core_numbers: "Core numbers", lo_shu: "Lo Shu grid", names: "Name numbers", lucky: "Lucky signs", report: "Numerology report", daily: "Today's prediction",
  palm_photos: "Palm photos", hand_type: "Hand type", lines: "Major lines", mounts: "Mounts", readings: "Readings",
  face_photos: "Face photos", features: "Features",
  spread: "Cards drawn", yes_no: "Yes / No card",
};
export const titleOf = (key: string): string => CARD_TITLES[key] ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export const missing = (key: string, note: string): CardOut => ({ key, title: titleOf(key), api: null, status: "missing", note });
export const ok = (key: string, api: unknown, note?: string, title?: string): CardOut => ({ key, title: title ?? titleOf(key), api, status: "ok", ...(note ? { note } : {}) });
export const notApplicable = (key: string, note: string): CardOut => ({ key, title: titleOf(key), api: null, status: "ok", note });

/** Exactly CARD_KEYS[discipline], in order. A key the builder skipped becomes `missing`; stray keys are dropped. */
export function normaliseCards(discipline: Discipline, cards: CardOut[]): CardOut[] {
  const by = new Map(cards.map((c) => [c.key, c]));
  return CARD_KEYS[discipline].map((k) => by.get(k) ?? missing(k, "Not generated"));
}

export type PrepStatusOut = "ready" | "partial" | "failed";
/** ready = nothing missing; failed = nothing usable; otherwise partial. */
export function prepStatusOf(cards: CardOut[]): PrepStatusOut {
  const bad = cards.filter((c) => c.status !== "ok").length;
  if (bad === 0) return "ready";
  return bad === cards.length ? "failed" : "partial";
}

export const clipStr = (v: unknown, max = 300): string => (v == null ? "" : String(v).replace(/\s+/g, " ").trim().slice(0, max));
export const parseHm = (v: unknown): { hour: number; min: number } | null => {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? "").trim());
  return m ? { hour: Number(m[1]), min: Number(m[2]) } : null;
};
