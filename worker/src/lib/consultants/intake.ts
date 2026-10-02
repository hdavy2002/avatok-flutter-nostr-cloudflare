// [AUMFE-CONSULT-W1-1 2026-10-02] Pure intake validation per discipline. NO I/O. The booking route stores the
// SANITISED value returned here (never the raw client object), so nothing unexpected reaches D1 or the prepare lane.
import type {
  AstrologyIntake, BirthBlock, Discipline, FaceIntake, Intake, NumerologyIntake, PalmistryIntake, TarotIntake,
} from "./types";

export type IntakeResult = { ok: true; value: Intake } | { ok: false; error: string; field: string; message: string };
const bad = (field: string, message: string): IntakeResult => ({ ok: false, error: "invalid_intake", field, message });

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f]/g;
export const cleanText = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Real calendar date, between 1900-01-01 and `now` (UTC day). */
export function validDob(v: unknown, now = Date.now()): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== v) return false;
  return t >= Date.parse("1900-01-01T00:00:00Z") && t <= now + 24 * 3600e3;
}

type Fail = { field: string; message: string };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function focusList(v: unknown, field: string): string[] | Fail {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 8) return { field, message: "Pick up to 8 focus areas." };
  const out: string[] = [];
  for (const x of v) { const s = cleanText(x, 40); if (s) out.push(s); }
  return [...new Set(out)];
}
const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

export function validateBirth(v: unknown, field: string, now = Date.now()): BirthBlock | Fail {
  if (!isObj(v)) return { field, message: "Birth details are required." };
  const name = cleanText(v.name, 80);
  if (name.length < 1) return { field: `${field}.name`, message: "Please enter the name." };
  if (v.gender !== "male" && v.gender !== "female" && v.gender !== "other") return { field: `${field}.gender`, message: "Please choose a gender." };
  if (!validDob(v.dob, now)) return { field: `${field}.dob`, message: "Please enter a valid date of birth." };
  const unknown = v.tob_unknown === true;
  let tob: string | null = null;
  if (!unknown) {
    if (typeof v.tob !== "string" || !HM_RE.test(v.tob)) return { field: `${field}.tob`, message: "Please enter the time of birth (HH:MM), or tick 'I don't know'." };
    tob = v.tob;
  }
  const place = cleanText(v.place, 120);
  if (place.length < 2) return { field: `${field}.place`, message: "Please enter the place of birth." };
  const lat = v.lat === null || v.lat === undefined ? null : num(v.lat, -90, 90);
  const lon = v.lon === null || v.lon === undefined ? null : num(v.lon, -180, 180);
  if ((v.lat != null && lat === null) || (v.lon != null && lon === null)) return { field: `${field}.lat`, message: "Place coordinates are invalid." };
  const tzone = v.tzone === null || v.tzone === undefined ? null : num(v.tzone, -12, 14);
  if (v.tzone != null && tzone === null) return { field: `${field}.tzone`, message: "Time zone is invalid." };
  return { name, gender: v.gender, dob: v.dob as string, tob, tob_unknown: unknown, place, lat, lon, tzone };
}

const isFail = (x: unknown): x is Fail => isObj(x) && typeof (x as Fail).field === "string" && typeof (x as Fail).message === "string" && !("dob" in x);

function astrology(v: Record<string, unknown>, now: number): IntakeResult {
  const birth = validateBirth(v.birth, "birth", now); if (isFail(birth)) return bad(birth.field, birth.message);
  const focus = focusList(v.focus, "focus"); if (isFail(focus)) return bad(focus.field, focus.message);
  let partner: BirthBlock | null = null;
  if (v.partner !== undefined && v.partner !== null) {
    const p = validateBirth(v.partner, "partner", now); if (isFail(p)) return bad(p.field, p.message);
    partner = p;
  }
  const out: AstrologyIntake = { kind: "astrology", birth, focus, partner };
  const gotra = cleanText(v.gotra, 40), ms = cleanText(v.marital_status, 30), city = cleanText(v.current_city, 80);
  if (gotra) out.gotra = gotra; if (ms) out.marital_status = ms; if (city) out.current_city = city;
  return { ok: true, value: out };
}

function numerology(v: Record<string, unknown>, now: number): IntakeResult {
  const birth_name = cleanText(v.birth_name, 80);
  if (birth_name.length < 2) return bad("birth_name", "Please enter the full name as on the birth record.");
  if (!validDob(v.dob, now)) return bad("dob", "Please enter a valid date of birth.");
  const out: NumerologyIntake = { kind: "numerology", birth_name, dob: v.dob as string };
  const used = cleanText(v.used_name, 80); if (used) out.used_name = used;
  if (v.mobile !== undefined && v.mobile !== null && v.mobile !== "") {
    const m = typeof v.mobile === "string" ? v.mobile.replace(/[\s-]/g, "") : "";
    if (!/^\+?\d{10,15}$/.test(m)) return bad("mobile", "Please enter a valid mobile number.");
    out.mobile = m;
  }
  if (v.names_to_check !== undefined && v.names_to_check !== null) {
    if (!Array.isArray(v.names_to_check) || v.names_to_check.length > 5) return bad("names_to_check", "You can check up to 5 names.");
    const names = v.names_to_check.map((x) => cleanText(x, 80)).filter(Boolean);
    if (names.length) out.names_to_check = names;
  }
  return { ok: true, value: out };
}

function palmistry(v: Record<string, unknown>): IntakeResult {
  if (v.dominant_hand !== "right" && v.dominant_hand !== "left") return bad("dominant_hand", "Please choose your dominant hand.");
  const focus = focusList(v.focus, "focus"); if (isFail(focus)) return bad(focus.field, focus.message);
  const out: PalmistryIntake = { kind: "palmistry", dominant_hand: v.dominant_hand, focus };
  if (v.age !== undefined && v.age !== null) {
    if (typeof v.age !== "number" || !Number.isInteger(v.age) || v.age < 5 || v.age > 120) return bad("age", "Please enter a valid age.");
    out.age = v.age;
  }
  const g = cleanText(v.gender, 20), o = cleanText(v.occupation, 60);
  if (g) out.gender = g; if (o) out.occupation = o;
  return { ok: true, value: out };
}

function face(v: Record<string, unknown>, now: number): IntakeResult {
  const focus = focusList(v.focus, "focus"); if (isFail(focus)) return bad(focus.field, focus.message);
  const out: FaceIntake = { kind: "face_reading", focus };
  const g = cleanText(v.gender, 20); if (g) out.gender = g;
  if (v.dob !== undefined && v.dob !== null && v.dob !== "") {
    if (!validDob(v.dob, now)) return bad("dob", "Please enter a valid date of birth.");
    out.dob = v.dob as string;
  }
  return { ok: true, value: out };
}

export const TAROT_DECK_SIZE = 78;
const cardNo = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < TAROT_DECK_SIZE ? v : null);

function tarot(v: Record<string, unknown>, now: number): IntakeResult {
  const name = cleanText(v.name, 80); if (!name) return bad("name", "Please enter your name.");
  const question = cleanText(v.question, 300); if (question.length < 3) return bad("question", "Please write your question.");
  if (!isObj(v.cards)) return bad("cards", "Please pick your three cards.");
  const love = cardNo(v.cards.love), career = cardNo(v.cards.career), finance = cardNo(v.cards.finance);
  if (love === null || career === null || finance === null) return bad("cards", "Please pick your three cards.");
  const picked = [love, career, finance];
  if (new Set(picked).size !== 3) return bad("cards", "Each card can be picked only once.");
  const out: TarotIntake = { kind: "tarot", name, question, cards: { love, career, finance } };
  if (v.dob !== undefined && v.dob !== null && v.dob !== "") {
    if (!validDob(v.dob, now)) return bad("dob", "Please enter a valid date of birth.");
    out.dob = v.dob as string;
  }
  if (v.reversed !== undefined && v.reversed !== null) {
    if (!isObj(v.reversed)) return bad("reversed", "Invalid card orientation.");
    const r: { love?: boolean; career?: boolean; finance?: boolean } = {};
    for (const k of ["love", "career", "finance"] as const) {
      const x = v.reversed[k];
      if (x === undefined) continue;
      if (typeof x !== "boolean") return bad("reversed", "Invalid card orientation.");
      r[k] = x;
    }
    out.reversed = r;
  }
  if (v.yes_no !== undefined && v.yes_no !== null) {
    if (!isObj(v.yes_no)) return bad("yes_no", "Invalid yes/no question.");
    const q = cleanText(v.yes_no.question, 200); const c = cardNo(v.yes_no.card);
    if (q.length < 3 || c === null) return bad("yes_no", "Please write the yes/no question and pick its card.");
    if (picked.includes(c)) return bad("yes_no", "The yes/no card must differ from your three cards.");
    out.yes_no = { question: q, card: c };
  } else out.yes_no = null;
  return { ok: true, value: out };
}

/** Validate + sanitise the intake for `discipline`. `intake.kind` must equal the discipline. */
export function validateIntake(discipline: Discipline, intake: unknown, now = Date.now()): IntakeResult {
  if (!isObj(intake)) return bad("intake", "Intake details are required.");
  if (intake.kind !== discipline) return bad("kind", "These details do not match the chosen service.");
  let res: IntakeResult;
  switch (discipline) {
    case "astrology": res = astrology(intake, now); break;
    case "numerology": res = numerology(intake, now); break;
    case "palmistry": res = palmistry(intake); break;
    case "face_reading": res = face(intake, now); break;
    case "tarot": res = tarot(intake, now); break;
    default: return bad("discipline", "Unknown service.");
  }
  if (res.ok && JSON.stringify(res.value).length > 6000) return bad("intake", "Details are too long.");
  return res;
}

/** Customer's questions for the consultant: up to 5, each ≤ 300 chars, blanks dropped. */
export function validateQuestions(v: unknown): { ok: true; value: string[] } | { ok: false; message: string } {
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v) || v.length > 5) return { ok: false, message: "You can ask up to 5 questions." };
  const out: string[] = [];
  for (const q of v) {
    if (typeof q !== "string") return { ok: false, message: "Questions must be text." };
    const s = cleanText(q, 301);
    if (s.length > 300) return { ok: false, message: "Each question can be up to 300 characters." };
    if (s) out.push(s);
  }
  return { ok: true, value: out };
}
