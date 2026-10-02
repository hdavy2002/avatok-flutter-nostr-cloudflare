// [AUMFE-CONSULT-W2-1 2026-10-02] Pure mappers for the desk file endpoints (rows -> DeskFileDTO parts).
import type { Discipline, FileCard, Intake, PhotoKind } from "../types";
import { CARD_KEYS } from "../types";
import { parseIsoDate } from "./numerology_calc";
import { titleOf } from "./shared";

export function ageFromDob(dob: string | null | undefined, nowMs: number): number | null {
  const p = dob ? parseIsoDate(dob) : null;
  if (!p) return null;
  const now = new Date(nowMs);
  let age = now.getUTCFullYear() - p.year;
  if (now.getUTCMonth() + 1 < p.month || (now.getUTCMonth() + 1 === p.month && now.getUTCDate() < p.day)) age--;
  return age >= 0 && age < 130 ? age : null;
}

/** Name / age / city the consultant sees, from whatever the discipline's intake holds. */
export function customerFromIntake(intake: Intake, nowMs: number): { name: string; city: string | null; age: number | null } {
  switch (intake.kind) {
    case "astrology": return { name: intake.birth.name, city: intake.current_city || intake.birth.place || null, age: ageFromDob(intake.birth.dob, nowMs) };
    case "numerology": return { name: intake.used_name || intake.birth_name, city: null, age: ageFromDob(intake.dob, nowMs) };
    case "palmistry": return { name: "", city: null, age: typeof intake.age === "number" ? intake.age : null };
    case "face_reading": return { name: "", city: null, age: ageFromDob(intake.dob ?? null, nowMs) };
    case "tarot": return { name: intake.name, city: null, age: ageFromDob(intake.dob ?? null, nowMs) };
  }
}

export interface CardRow { key: string; title: string; api_json: string | null; override_json: string | null; edited_by: string | null; edited_at: number | null; status: "ok" | "missing" | "error"; note: string | null }
const parse = (s: string | null): unknown => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };

export function toFileCard(r: CardRow): FileCard {
  return {
    key: r.key, title: r.title, api: parse(r.api_json), override: parse(r.override_json), edited_by: r.edited_by, edited_at: r.edited_at, status: r.status,
    ...(r.note ? { note: r.note } : {}),
  };
}

/** Exactly CARD_KEYS[discipline], in order; a card with no row yet is shown as missing ("not prepared yet"). */
export function orderCards(discipline: Discipline, rows: CardRow[]): FileCard[] {
  const by = new Map(rows.map((r) => [r.key, r]));
  return CARD_KEYS[discipline].map((k) => {
    const r = by.get(k);
    return r ? toFileCard(r) : { key: k, title: titleOf(k), api: null, override: null, edited_by: null, edited_at: null, status: "missing" as const, note: "Not prepared yet" };
  });
}

export const PHOTO_KINDS_FOR: Record<string, PhotoKind[]> = { palmistry: ["palm_right", "palm_left"], face_reading: ["face_front", "face_side"] };
