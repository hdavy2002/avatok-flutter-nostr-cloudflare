// Shared types, formatters and tiny presentational primitives for the admin
// listings review workbench. Split out of AdminListings.tsx so each panel
// (queue / submission / poster / history) can stay under ~200 lines.
import type { ReactNode } from 'react';

// ───────────────────────── API shapes (MKT-ADMIN-UI-1) ─────────────────────
// Matches GET /api/admin/listings/:id from Agent A's endpoint. `listing` is
// "every listings column" — loosely typed here on purpose, since the exact
// column set is the worker's D1 schema, not something this file should pin.
// `attrs` is the parsed JSON blob; cover_media/badges/vibe_tags/
// recurrence_days/spoken_lang are parsed arrays living at the top level.
export type ListingAttrs = Record<string, unknown>;
export type ListingDetail = Record<string, unknown> & {
  id: string;
  title?: string | null;
  status?: string | null;
  kind?: string | null;
  attrs?: ListingAttrs | null;
  cover_media?: Array<{ url?: string; [k: string]: unknown }> | null;
  badges?: string[] | null;
  vibe_tags?: string[] | null;
  recurrence_days?: string[] | null;
  spoken_lang?: string[] | null;
};

export type CreatorInfo = {
  id?: string | null;
  handle?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
  kyc_status?: string | null;
} | null;

export type PosterStatus = 'generating' | 'draft' | 'approved' | 'rejected' | 'failed';
export type PosterInfo = {
  status?: PosterStatus | string;
  url?: string | null;
  generated_at?: number | null;
  completed_at?: number | null;
  provider?: string | null;
  prompt?: string | null;
  error?: string | null;
  feedback?: string | null;
  attempt?: number | null;
  auto?: boolean | null;
} | null;

export type HistoryRow = {
  id: string;
  actor_id?: string | null;
  action: string;
  previous_status?: string | null;
  next_status?: string | null;
  reason?: string | null;
  poster_status?: string | null;
  created_at: number;
};

export type CategoryInfo = { id: string; label: string; vertical?: string; intent?: string } | null;

export type ListingSlotRow = Record<string, unknown>;

// [LISTING-BLOCKERS-1 2026-09-05] The server's own answer to "can this go
// live?", from worker/src/lib/listing_blockers.ts. The admin queue renders THIS
// rather than keeping a checklist of its own — a second copy of the rules is
// what let a listing be approved by a reviewer and then refused by publish.
export type ListingBlocker = {
  code: string;
  field: string | null;
  message: string;
};

export type AdminListingDetailResponse = {
  listing: ListingDetail;
  creator: CreatorInfo;
  poster: PosterInfo;
  history: HistoryRow[];
  category: CategoryInfo;
  slots: ListingSlotRow[];
  blockers?: ListingBlocker[];
  publishable?: boolean;
};

// Queue-row shape from the unchanged GET /api/admin/listings?status= list.
export type ListingRow = {
  id: string;
  title?: string;
  description?: string;
  kind?: string;
  status?: string;
  price?: number | null;
  cover_media?: Array<{ url?: string }>;
  created_at?: number;
  updated_at?: number;
  creator_id?: string;
};

// ───────────────────────── formatters ─────────────────────
export const fmt = (ms?: number | null) =>
  ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

// Owner rule (2026-08-05): the unit is a TOKEN, 1 token = ₹1. Never print $.
export const money = (n?: number | null) => (typeof n === 'number' ? `₹${n}` : '—');

export const yesNo = (v: unknown) => (v === true ? 'Yes' : v === false ? 'No' : null);

/**
 * A creator-submitted field may land as a real `listings` column OR inside
 * the parsed `attrs` blob — the endpoint spec groups fields by meaning, not
 * by which physical column backs them, and several of the fields this task
 * asks to render (e.g. the agent-mandate group) may not be columns on
 * `listings` at all. Checking both sides means the panel never silently
 * misses a value because of that ambiguity.
 */
export function pick(listing: ListingDetail | null | undefined, attrs: ListingAttrs | null | undefined, key: string): unknown {
  const top = listing ? (listing as Record<string, unknown>)[key] : undefined;
  if (top !== undefined && top !== null && top !== '') return top;
  const nested = attrs ? attrs[key] : undefined;
  if (nested !== undefined && nested !== null && nested !== '') return nested;
  return undefined;
}

export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

/** Renders any submitted value (primitive, array, or object) without ever falling back to a bare JSON dump for common shapes. */
export function renderAny(v: unknown): ReactNode {
  if (isEmptyValue(v)) return null;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'string' || typeof x === 'number')) {
      return (
        <div className="flex flex-wrap gap-1.5">
          {v.map((x, i) => (
            <span key={i} className="rounded-full border-zine border-ink bg-paper px-2 py-0.5 font-mono text-[12px] font-bold text-ink">{String(x)}</span>
          ))}
        </div>
      );
    }
    return (
      <ul className="ml-4 list-disc space-y-1">
        {v.map((item, i) => (
          <li key={i} className="font-body text-[14px] font-bold leading-snug text-ink">{renderObjectInline(item)}</li>
        ))}
      </ul>
    );
  }
  if (typeof v === 'object') return renderObjectInline(v);
  return String(v);
}

function renderObjectInline(v: unknown): ReactNode {
  if (v === null || v === undefined) return '—';
  if (typeof v !== 'object') return String(v);
  const entries = Object.entries(v as Record<string, unknown>).filter(([, val]) => !isEmptyValue(val));
  if (entries.length === 0) return '—';
  // Common shapes creators submit: {label,body} / {heading,body} / {q,a} / {who,line}
  const rec = v as Record<string, unknown>;
  const primary = rec.label ?? rec.heading ?? rec.q ?? rec.who ?? rec.title;
  const secondary = rec.body ?? rec.a ?? rec.line ?? rec.description;
  if ((primary || secondary) && entries.length <= 2) {
    return (
      <>
        {primary ? <strong className="text-ink">{String(primary)}: </strong> : null}
        {secondary ? String(secondary) : null}
      </>
    );
  }
  return (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-0.5">
      {entries.map(([k, val]) => (
        <span key={k}><strong className="text-inkMute">{k}:</strong> {typeof val === 'object' ? JSON.stringify(val) : String(val)}</span>
      ))}
    </span>
  );
}

export function Badge({ children, tone = 'bg-paper2 text-inkSoft' }: { children: ReactNode; tone?: string }) {
  return <span className={`inline-flex items-center rounded-full border-zine border-ink px-2 py-0.5 font-mono text-[12px] font-bold uppercase tracking-[0.04em] ${tone}`}>{children}</span>;
}

/** A single labelled field row. Renders nothing when the value is empty (spec: don't wall the admin in blanks). */
export function Field({ label, value, allowEmptyLabel }: { label: string; value: unknown; allowEmptyLabel?: string }) {
  const rendered = renderAny(value);
  if (rendered === null || rendered === undefined) {
    if (!allowEmptyLabel) return null;
    return (
      <div className="grid grid-cols-[minmax(0,140px)_1fr] items-start gap-3 py-1.5">
        <span className="font-mono text-[12px] font-bold uppercase tracking-[0.04em] text-inkMute">{label}</span>
        <span className="font-body text-[13px] font-bold italic text-placeholder">{allowEmptyLabel}</span>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[minmax(0,140px)_1fr] items-start gap-3 py-1.5">
      <span className="font-mono text-[12px] font-bold uppercase tracking-[0.04em] text-inkMute">{label}</span>
      <div className="min-w-0 font-body text-[14px] font-bold leading-snug text-ink">{rendered}</div>
    </div>
  );
}

export function Group({ title, tone, note, children }: { title: string; tone?: string; note?: string; children: ReactNode }) {
  return (
    <section className={`rounded-zineField border-zine border-ink p-4 ${tone ?? 'bg-paper2'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-display text-[15px] font-semibold uppercase tracking-[0.02em] text-ink">{title}</h4>
        {note && <span className="rounded-full border-zine border-ink bg-coral px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-paper">{note}</span>}
      </div>
      <div className="mt-2 divide-y divide-ink/10">{children}</div>
    </section>
  );
}
