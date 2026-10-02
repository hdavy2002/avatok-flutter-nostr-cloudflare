// [AUMFE-CONSULT-F2-1 2026-10-02] Pure logic for the booking wizard (no DOM, no React) so it can be unit-tested with
// node:test (web/test/consult_book_logic.test.ts). Numerology preview, .ics builder, camera frame quality, IST helpers,
// per-discipline validation + intake builders.
import type {
  AstrologyIntake, BirthBlock, Discipline, FaceIntake, Intake, NumerologyIntake, PalmistryIntake, TarotIntake,
} from '../../lib/consultTypes';

// ───────── form shapes (strings while typing; converted to the Intake contract on submit) ─────────
export interface BirthForm {
  name: string; gender: '' | 'male' | 'female' | 'other'; dob: string; tob: string; tobUnknown: boolean; place: string;
  /** Coordinates already known for `place` (from the saved profile). Cleared the moment the place text changes. */
  geo: { lat: number; lon: number; tzone: number | null } | null;
}
export interface AstroForm { birth: BirthForm; gotra: string; marital: string; city: string; focus: string[]; partnerOn: boolean; partner: BirthForm }
export interface NumeroForm { birthName: string; usedName: string; dob: string; mobile: string; names: string[] }
export interface PalmForm { hand: 'right' | 'left'; age: string; gender: string; occupation: string; focus: string[] }
export interface FaceForm { gender: string; dob: string; focus: string[] }
export interface TarotForm {
  name: string; dob: string; question: string;
  picks: number[]; reversed: boolean[]; yesNo: boolean; yesNoCard: number | null;
}

export const EMPTY_BIRTH: BirthForm = { name: '', gender: '', dob: '', tob: '', tobUnknown: false, place: '', geo: null };
export const FOCUS_OPTIONS = ['Career', 'Marriage', 'Health', 'Money', 'Education', 'Children'];
export const MARITAL_OPTIONS = ['Single', 'Married', 'Divorced', 'Widowed'];

// ───────── numerology (first look; the consultant works out the rest) ─────────
export function digitRoot(n: number): number {
  let v = Math.abs(Math.trunc(n));
  while (v > 9) {
    let s = 0;
    while (v > 0) { s += v % 10; v = Math.floor(v / 10); }
    v = s;
  }
  return v;
}
const DOB_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Moolank (psychic number): the day of birth reduced to one digit. */
export function moolank(dob: string): number | null {
  const m = DOB_RE.exec(dob);
  if (!m) return null;
  const day = Number(m[3]);
  return day > 0 ? digitRoot(day) : null;
}
/** Bhagyank (destiny number): every digit of the full date added, reduced to one digit. */
export function bhagyank(dob: string): number | null {
  const m = DOB_RE.exec(dob);
  if (!m || Number(m[3]) === 0) return null;
  let sum = 0;
  for (const ch of m[1] + m[2] + m[3]) sum += Number(ch);
  return digitRoot(sum);
}
export function toDeva(n: number): string {
  return String(n).replace(/\d/g, (d) => '०१२३४५६७८९'[Number(d)]);
}

// ───────── calendar file ─────────
function icsStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function icsText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
export function buildIcs(o: { uid: string; title: string; startMs: number; endMs: number; description: string; url?: string; prodId: string }): string {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${icsText(o.prodId)}//Consult//EN`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsText(o.uid)}`,
    `DTSTAMP:${icsStamp(Date.now())}`,
    `DTSTART:${icsStamp(o.startMs)}`,
    `DTEND:${icsStamp(o.endMs)}`,
    `SUMMARY:${icsText(o.title)}`,
    `DESCRIPTION:${icsText(o.description)}`,
    ...(o.url ? [`URL:${o.url}`] : []),
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(o.title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}

// ───────── camera frame quality (canvas pixels in, verdict out) ─────────
/** Tunable: tuned on a 240 px wide frame. Below MIN_BRIGHT is too dark, above MAX_BRIGHT is blown out. */
export const MIN_BRIGHT = 70;
export const MAX_BRIGHT = 215;
export const MIN_SHARP = 25;
export interface FrameStats { brightness: number; sharpness: number }
export function frameStats(rgba: Uint8ClampedArray, w: number, h: number): FrameStats {
  const g = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    const v = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    g[i] = v;
    sum += v;
  }
  let n = 0, m = 0, m2 = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const c = y * w + x;
      const l = 4 * g[c] - g[c - 1] - g[c + 1] - g[c - w] - g[c + w]; // Laplacian
      n++; m += l; m2 += l * l;
    }
  }
  const mean = n ? m / n : 0;
  return { brightness: w * h ? sum / (w * h) : 0, sharpness: n ? m2 / n - mean * mean : 0 };
}
export type LightVerdict = 'ok' | 'dark' | 'bright';
export function lightVerdict(b: number): LightVerdict { return b < MIN_BRIGHT ? 'dark' : b > MAX_BRIGHT ? 'bright' : 'ok'; }
export function isSharp(s: number): boolean { return s >= MIN_SHARP; }

// ───────── IST helpers ─────────
const IST_MS = 5.5 * 3600_000;
export function istTodayISO(now = Date.now()): string { return new Date(now + IST_MS).toISOString().slice(0, 10); }
const DAY_FMT = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
const TIME_FMT = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
export function fmtSlotDay(ms: number): string { return DAY_FMT.format(ms).replace(',', ''); }
export function fmtSlotTime(ms: number): string { return TIME_FMT.format(ms).toUpperCase(); }
/** 'YYYY-MM-DD' -> { dow: 'Tue', day: 6 } without a timezone shift. */
export function dayParts(date: string): { dow: string; day: number } {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()], day: d || 1 };
}
export function maskEmail(e: string): string {
  const at = e.indexOf('@');
  return at > 0 ? `${e.slice(0, at)}@••••` : '••••';
}
export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ───────── validation + intake builders (the contract in lib/consultTypes.ts) ─────────
function birthBlock(b: BirthForm, fallbackName: string): BirthBlock {
  return {
    name: b.name.trim() || fallbackName,
    gender: (b.gender || 'other') as BirthBlock['gender'],
    dob: b.dob,
    tob: b.tobUnknown ? null : (b.tob || null),
    tob_unknown: b.tobUnknown,
    place: b.place.trim(),
    lat: b.geo?.lat ?? null,
    lon: b.geo?.lon ?? null,
    tzone: b.geo?.tzone ?? null,
  };
}
function birthProblem(b: BirthForm, who: string): string | null {
  if (!b.name.trim()) return `Please add ${who} name.`;
  if (!b.gender) return `Please choose ${who} gender.`;
  if (!b.dob) return `Please add ${who} date of birth.`;
  if (!b.tobUnknown && !b.tob) return `Please add ${who} time of birth, or tick “I don't know my birth time”.`;
  if (!b.place.trim()) return `Please add ${who} place of birth.`;
  return null;
}
export function astroProblem(f: AstroForm): string | null {
  const p = birthProblem(f.birth, 'your');
  if (p) return p;
  if (f.partnerOn) {
    const q = birthProblem(f.partner, "your partner's");
    if (q) return q;
  }
  return null;
}
export function astroIntake(f: AstroForm): AstrologyIntake {
  return {
    kind: 'astrology',
    birth: birthBlock(f.birth, ''),
    ...(f.gotra.trim() ? { gotra: f.gotra.trim() } : {}),
    ...(f.marital ? { marital_status: f.marital } : {}),
    ...(f.city.trim() ? { current_city: f.city.trim() } : {}),
    focus: f.focus,
    partner: f.partnerOn ? birthBlock(f.partner, '') : null,
  };
}
export function numeroProblem(f: NumeroForm): string | null {
  if (!f.birthName.trim()) return 'Please add your full name as on your documents.';
  if (!f.dob) return 'Please add your date of birth.';
  if (f.mobile.trim() && f.mobile.replace(/\D/g, '').length < 10) return 'That mobile number looks too short.';
  return null;
}
export function numeroIntake(f: NumeroForm): NumerologyIntake {
  const names = f.names.map((n) => n.trim()).filter(Boolean);
  return {
    kind: 'numerology',
    birth_name: f.birthName.trim(),
    ...(f.usedName.trim() ? { used_name: f.usedName.trim() } : {}),
    dob: f.dob,
    ...(f.mobile.trim() ? { mobile: f.mobile.trim() } : {}),
    ...(names.length ? { names_to_check: names } : {}),
  };
}
export function palmProblem(f: PalmForm): string | null {
  if (f.age && (!/^\d{1,3}$/.test(f.age) || Number(f.age) < 5 || Number(f.age) > 110)) return 'Please enter a sensible age.';
  return null;
}
export function palmIntake(f: PalmForm): PalmistryIntake {
  return {
    kind: 'palmistry',
    dominant_hand: f.hand,
    ...(f.age ? { age: Number(f.age) } : {}),
    ...(f.gender ? { gender: f.gender } : {}),
    ...(f.occupation.trim() ? { occupation: f.occupation.trim() } : {}),
    focus: f.focus,
  };
}
export function faceIntake(f: FaceForm): FaceIntake {
  return { kind: 'face_reading', ...(f.gender ? { gender: f.gender } : {}), dob: f.dob || null, focus: f.focus };
}
export function tarotDrawn(f: TarotForm): boolean {
  return f.picks.length >= 3 && (!f.yesNo || f.yesNoCard != null);
}
export function tarotProblem(f: TarotForm): string | null {
  if (!f.name.trim()) return 'Please add your name.';
  if (!f.question.trim()) return 'Please type the question you want to ask.';
  if (!tarotDrawn(f)) return 'Please draw all your cards.';
  return null;
}
export function tarotIntake(f: TarotForm): TarotIntake {
  return {
    kind: 'tarot',
    name: f.name.trim(),
    dob: f.dob || null,
    question: f.question.trim(),
    cards: { love: f.picks[0], career: f.picks[1], finance: f.picks[2] },
    reversed: { love: !!f.reversed[0], career: !!f.reversed[1], finance: !!f.reversed[2] },
    yes_no: f.yesNo && f.yesNoCard != null ? { question: f.question.trim(), card: f.yesNoCard } : null,
  };
}
/** Disciplines that need photos at step 2, and which kinds (first is required, second optional). */
export function photoKinds(d: Discipline, hand: 'right' | 'left'): { kind: 'palm_right' | 'palm_left' | 'face_front' | 'face_side'; optional: boolean }[] {
  if (d === 'palmistry') {
    const first = hand === 'right' ? 'palm_right' : 'palm_left';
    const second = hand === 'right' ? 'palm_left' : 'palm_right';
    return [{ kind: first, optional: false }, { kind: second, optional: true }];
  }
  if (d === 'face_reading') return [{ kind: 'face_front', optional: false }, { kind: 'face_side', optional: true }];
  return [];
}
export function intakeSignature(i: Intake, slot: number, questions: string[]): string {
  return JSON.stringify([i, slot, questions]);
}
