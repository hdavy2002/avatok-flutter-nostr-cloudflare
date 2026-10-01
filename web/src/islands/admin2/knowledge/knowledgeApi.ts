// [AUMFE-KNOWLEDGE-ADMIN-UI-1 2026-10-01] Typed calls for the Admin 2 "Tradition library" screens.
// Worker: worker/src/routes/admin2_knowledge.ts (+ the AI drafting routes being built beside it).
// Shapes are declared locally so this island has no cross-agent import dependency.
import { ApiError } from '../adminApi';
import { adminCall } from '../peopleKit';

const B = '/api/admin/v2/knowledge';

export type EntryStatus = 'draft' | 'approved' | 'archived';
export interface TraditionEntry {
  id: string; topic: string; title: string; text: string; source: string; lang: string;
  graha: string | null; weekday: string | null; deity: string | null;
  status: EntryStatus; chunk_count: number; indexed_at: number | null; created_at: number; updated_at: number; updated_by: string | null;
}
export interface TraditionFields {
  topic: string; title: string; text: string; source: string; lang?: string;
  graha: string | null; weekday: string | null; deity: string | null;
}
export interface ImportResult { imported: number; skipped: { index: number; reason: string }[]; status: string }

export type NoteStatus = 'draft' | 'approved' | 'rejected';
export type MatchStep = 'deity' | 'chakra' | 'print_colour' | 'shirt_colour';
export interface MatchReason { step: MatchStep; fact: string; source_id?: string }
/** The raw D1 row: list-ish columns arrive as JSON strings. */
export interface NoteRow {
  id: string; subject_kind: string; subject_id: string; design_type: string | null;
  design_elements_json: string; print_colours_json: string; shirt_colour: string | null;
  deity: string | null; graha: string | null; chakra: string | null; wear_days_json: string; occasions_json: string;
  mantra: string | null; tradition_note: string; story: string; sources_json: string; match_reasons_json: string;
  status: NoteStatus | string; drafted_at: number | null; approved_by: string | null; approved_at: number | null; updated_at: number;
}
export interface NoteBody {
  design_type: string | null; design_elements: string[]; print_colours: string[]; shirt_colour: string | null;
  deity: string | null; graha: string | null; chakra: string | null; wear_days: string[]; occasions: string[];
  mantra: string | null; tradition_note: string; story: string; sources: unknown[]; match_reasons: MatchReason[];
}

export interface TraditionHit { id: string; title: string; text: string; source: string; topic: string; score: number }
export interface CatalogHit {
  subject_kind: string; subject_id: string; title: string; price_inr: number | null; image_url: string | null; url: string;
  wear_days: string[]; deity: string | null; chakra: string | null; tradition_note: string; why: MatchReason[]; score: number;
}
export interface ReindexResult { index: string; ok: number; failed: number; reasons: Record<string, number>; ms: number; next_cursor?: string | null; remaining?: number }
export interface DraftMissingResult { drafted: number; failed: number; remaining: number }

export const parseAny = (s: unknown): unknown[] => {
  if (typeof s !== 'string' || !s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
};
export const parseList = (s: unknown): string[] => parseAny(s).filter((x): x is string => typeof x === 'string');

/** True when the route is not deployed (yet): the AI drafting routes ship separately. */
export const isMissingRoute = (e: unknown): boolean => e instanceof ApiError && (e.status === 404 || e.status === 405);

const enc = encodeURIComponent;
const post = <T,>(path: string, body?: unknown) => adminCall<T>(path, { method: 'POST', body: body ?? {} });

export const knowledgeApi = {
  list: (q: { status?: string; topic?: string; q?: string }) =>
    adminCall<{ entries: TraditionEntry[] }>(`${B}/tradition`, { query: q }).then((r) => r.entries ?? []),
  create: (f: TraditionFields) => post<{ id: string; status: string }>(`${B}/tradition`, f),
  update: (id: string, f: TraditionFields) => adminCall<{ id: string; status: string }>(`${B}/tradition/${enc(id)}`, { method: 'PUT', body: f }),
  archive: (id: string) => adminCall<{ id: string; status: string }>(`${B}/tradition/${enc(id)}`, { method: 'DELETE' }),
  approve: (id: string) => post<{ id: string; status: string; indexed: boolean; reason: string | null }>(`${B}/tradition/${enc(id)}/approve`),
  importBatch: (entries: Record<string, unknown>[]) => post<ImportResult>(`${B}/tradition/import`, { entries }),

  getNote: (kind: string, id: string) => adminCall<{ note: NoteRow | null }>(`${B}/notes/${kind}/${enc(id)}`).then((r) => r.note),
  putNote: (kind: string, id: string, b: NoteBody) =>
    adminCall<{ note: NoteRow }>(`${B}/notes/${kind}/${enc(id)}`, { method: 'PUT', body: b }).then((r) => r.note),
  approveNote: (kind: string, id: string) => post<{ status: string; indexed: boolean; reason: string | null }>(`${B}/notes/${kind}/${enc(id)}/approve`),
  rejectNote: (kind: string, id: string) => post<{ status: string }>(`${B}/notes/${kind}/${enc(id)}/reject`),
  /** Being built in parallel: callers must handle isMissingRoute(). Answers the note row (bare or {note}). */
  draftNote: (kind: string, id: string, hints?: Partial<NoteBody>) =>
    post<NoteRow | { note: NoteRow }>(`${B}/notes/${kind}/${enc(id)}/draft`, hints ? { hints } : {})
      .then((r) => ('note' in r ? r.note : r) as NoteRow),
  draftMissing: () => post<DraftMissingResult>(`${B}/notes/draft-missing`),

  reindex: (index: 'tradition' | 'catalog', cursor?: string | null) => post<ReindexResult>(`${B}/reindex`, { index, cursor: cursor ?? undefined }),
  search: (index: 'tradition' | 'catalog', q: string) =>
    adminCall<{ index: string; q: string; hits: (TraditionHit | CatalogHit)[] }>(`${B}/search`, { query: { index, q } }).then((r) => r.hits ?? []),
};

/* ───────── shared vocab ───────── */

export const GRAHAS = ['surya', 'chandra', 'mangal', 'budh', 'guru', 'shukra', 'shani', 'rahu', 'ketu'] as const;
export const GRAHA_HINT: Record<string, string> = {
  surya: 'Sun', chandra: 'Moon', mangal: 'Mars', budh: 'Mercury', guru: 'Jupiter', shukra: 'Venus', shani: 'Saturn', rahu: 'Rahu', ketu: 'Ketu',
};
export const CHAKRAS = ['muladhara', 'svadhisthana', 'manipura', 'anahata', 'vishuddha', 'ajna', 'sahasrara'] as const;
export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export const DESIGN_TYPES = ['deity', 'symbol', 'chakra', 'mandala', 'yantra', 'mantra', 'other'] as const;
export const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
export const grahaLabel = (g: string) => (GRAHA_HINT[g] ? `${cap(g)} (${GRAHA_HINT[g]})` : cap(g));

export const wordCount = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

export const REVIEW_NOTICE = 'Entries are drafts until a qualified pandit has reviewed them.';
