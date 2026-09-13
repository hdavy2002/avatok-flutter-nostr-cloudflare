/* [CARD-AI-REVIEW-1 2026-09-03, owner decision] The AI copy assist.
 *
 * Owner's ask: every card is reviewed by AI while the form is being filled —
 * the title is sized to the card, the description is grown or trimmed — so the
 * grid stops looking like some tiles were finished and others abandoned.
 *
 * [WIZ-AI-ASSIST-1 2026-09-13] This used to be one <Card> panel at the END of
 * the wizard (step 8), which is the wrong place twice over: the words are
 * written on step 2, and a suggestion offered after seven more steps is a
 * suggestion nobody takes. It is now a per-field affordance rendered ABOVE each
 * of title / blurb / description on step 2, and passing that step requires
 * having been through it (see wizardLogic.validateStep case 1).
 *
 * [WIZ-AI-PERFIELD-1 2026-09-13, owner decision] ONE FIELD AT A TIME. The first
 * cut fired a single call that reviewed all three fields, so pressing "Write my
 * title for me" opened three cards — two of them about fields the creator had
 * not written yet, carrying notes about their own emptiness. Pressing a field's
 * button now sends `field: '<that field>'` and the server reviews ONLY that
 * field, returning the other two as null. Each field owns its own request, its
 * own busy flag, its own result and its own error; nothing a field's button
 * does can reach another field's card.
 *
 * The file is a HOOK plus a small presentational component, not a panel:
 * `useCopyReview` owns three independent POST /api/listings/copy-review calls
 * keyed by field, and `CopyFieldAssist` renders one field's blip row from that
 * field's slice — and only that slice.
 *
 * Four things this deliberately does NOT do:
 *
 *  1. It never edits the draft on its own. Each field gets its own "Use this".
 *     The words a creator publishes stay theirs to accept.
 *  2. It never claims an AI review that did not happen. The worker returns
 *     `source: 'ai' | 'rules'` plus an `ai_status` code; when the model is off,
 *     unreachable, or refused the text, the row says WHICH of those it was
 *     rather than one blanket "unavailable" for every cause.
 *  3. It does not block on the network to be useful. A failed call leaves the
 *     creator exactly where they were, with a retry AND an escape — see
 *     `anyFailed` and the "Continue without AI" control in steps.tsx. An
 *     endpoint that is down must never be able to trap someone inside step 2.
 *  4. It does not re-run once a field is settled. `assisted` is checked by the
 *     caller before anything is offered, so a creator stepping back into step 2
 *     sees a quiet done state, not a fresh prompt.
 */
import { useCallback, useMemo, useState } from 'react';
import { request } from '../../../lib/apiClient';
import { getActiveToken } from '../../../lib/clerk';
import { capture } from '../../../lib/analytics';
import type { ListingDraft } from './types';

interface ReviewField { original: string; suggested: string; note: string | null }

/** [WIZ-AI-PERFIELD-1] The worker's shape. With `field` in the request the two
 *  fields that were not asked about come back as `null`. */
export interface CopyReviewResult {
  title: ReviewField | null;
  blurb: ReviewField | null;
  description: ReviewField | null;
  source: 'ai' | 'rules';
  /** 'ok' | 'moderation_blocked' | 'provider_error' | 'bad_json' | 'disabled'.
   *  Absent on an older worker — the UI falls back to the old wording. */
  ai_status?: string | null;
}

export type CopyField = 'title' | 'blurb' | 'description';

const FIELDS: CopyField[] = ['title', 'blurb', 'description'];

/** Everything ONE field knows about its own check. No field can read or write
 *  another field's slice — that is the whole point of the refactor. */
export interface CopyFieldSlice {
  result: ReviewField | null;
  source: 'ai' | 'rules' | null;
  aiStatus: string | null;
  busy: boolean;
  error: string | null;
  /** True once THIS field's call has come back with an error. */
  failed: boolean;
}

const EMPTY_SLICE: CopyFieldSlice = {
  result: null, source: null, aiStatus: null, busy: false, error: null, failed: false,
};

export interface CopyReviewState {
  fields: Record<CopyField, CopyFieldSlice>;
  /** Run the check for ONE field. Touches only that field's slice. */
  run: (field: CopyField) => Promise<void>;
  /** Any field mid-flight — drives the shared "Trying again…" label. */
  anyBusy: boolean;
  /** Any field has failed at least once — earns the "Continue without AI" escape. */
  anyFailed: boolean;
  /** Retry every field that failed, each as its own request. */
  retryFailed: () => Promise<void>;
}

/** Three independent fetches, one per field, each with its own state. */
export function useCopyReview(draft: ListingDraft): CopyReviewState {
  const [fields, setFields] = useState<Record<CopyField, CopyFieldSlice>>({
    title: EMPTY_SLICE, blurb: EMPTY_SLICE, description: EMPTY_SLICE,
  });

  const { title, blurb, description, kind, category, free_entry: freeEntry } = draft;

  const patchField = useCallback((field: CopyField, p: Partial<CopyFieldSlice>) => {
    // Functional update, one key only: a call for `blurb` can never rewrite the
    // title or description slice, even if two calls are in flight at once.
    setFields((prev) => ({ ...prev, [field]: { ...prev[field], ...p } }));
  }, []);

  const run = useCallback(async (field: CopyField) => {
    patchField(field, { busy: true, error: null });
    try {
      const token = await getActiveToken();
      const r = await request<CopyReviewResult>('/api/listings/copy-review', {
        method: 'POST',
        auth: token ?? undefined,
        body: { title, blurb, description, kind, category, free_entry: freeEntry, field },
      });
      // Read ONLY this field off the response. The other two keys are null by
      // contract; even if a stale worker sent all three we ignore them here.
      patchField(field, {
        result: r?.[field] ?? null,
        source: r?.source ?? null,
        aiStatus: r?.ai_status ?? null,
        failed: false,
        error: null,
        busy: false,
      });
      capture('listing_copy_review_run', {
        field, source: r?.source, ai_status: r?.ai_status ?? null, kind, outcome: 'ok',
      });
    } catch {
      patchField(field, {
        error: 'Could not reach the AI check just now.', failed: true, busy: false,
      });
      capture('listing_copy_review_run', { field, kind, outcome: 'error' });
    }
  }, [patchField, title, blurb, description, kind, category, freeEntry]);

  const anyBusy = FIELDS.some((f) => fields[f].busy);
  const anyFailed = FIELDS.some((f) => fields[f].failed);

  const retryFailed = useCallback(async () => {
    const pending = FIELDS.filter((f) => fields[f].failed);
    await Promise.all(pending.map((f) => run(f)));
  }, [fields, run]);

  return useMemo(
    () => ({ fields, run, anyBusy, anyFailed, retryFailed }),
    [fields, run, anyBusy, anyFailed, retryFailed],
  );
}

const chipBase = 'rounded-zineField border-zine border-ink px-3 py-1.5 font-body font-bold text-[12px] shadow-zine-xs';

/* [WIZ-AI-PERFIELD-1] One short, TRUE sentence per outcome. "Ava was
 * unavailable" was being shown for a provider outage, for a switched-off model
 * and for copy her safety check refused — three different things, and only one
 * of them is worth the creator rewording anything. No jargon, no model names.
 * An older worker sends no `ai_status`: that falls through to the old line. */
function eyebrowLine(label: string, slice: CopyFieldSlice): string {
  const lower = label.toLowerCase();
  if (slice.source === 'ai') return `Ava’s ${lower}`;
  switch (slice.aiStatus) {
    case 'moderation_blocked': return `Ava passed on this one — length check only`;
    case 'provider_error': return `Ava could not answer just now — length check only`;
    case 'bad_json': return `Ava’s answer came back garbled — length check only`;
    case 'disabled': return `Ava is switched off right now — length check only`;
    default: return `Length check only — Ava was unavailable`;
  }
}

/** One field's blip row, rendered directly ABOVE that field on step 2. */
export function CopyFieldAssist({
  field, label, state, patch, assisted, onSettled,
}: {
  field: CopyField;
  label: string;
  state: CopyReviewState;
  patch: (p: Partial<ListingDraft>) => void;
  /** Has this field already been through the check? Drives the quiet done state. */
  assisted: boolean;
  /** Applied a suggestion, or kept their own words — either settles the field. */
  onSettled: (how: 'applied' | 'kept') => void;
}) {
  // The ONLY slice this component ever reads or acts on.
  const slice = state.fields[field];
  const { result: f, busy, error } = slice;

  if (assisted) {
    return (
      <p className="mb-1.5 font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkMute">
        ✓ AI checked
      </p>
    );
  }

  // Nothing back yet — the invitation. One press runs THIS field's call and
  // nothing else: the other two rows keep whatever state they already had.
  if (!f) {
    return (
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">Use AI</span>
        <button type="button" disabled={busy} onClick={() => void state.run(field)}
          className={[chipBase, busy ? 'bg-paper2 text-inkMute' : 'bg-blue text-ink'].join(' ')}>
          {busy ? 'Asking Ava…' : `✦ Write my ${label.toLowerCase()} for me`}
        </button>
        {error && <span className="font-body font-bold text-[12px] text-coral">⚠ {error}</span>}
      </div>
    );
  }

  // [WIZ-AI-PERFIELD-1] The empty-field case. The server no longer "reviews
  // nothing" on a blank field — it WRITES one from the rest of the listing. So
  // a suggestion against an empty original is an offer to accept, never
  // "nothing to change": that branch is now reserved for the case where the
  // creator's own words came back unchanged.
  const wasEmpty = !f.original.trim();
  const hasSuggestion = !!f.suggested.trim() && f.suggested !== f.original;
  return (
    <div className="mb-1.5 rounded-zine border-zine border-dashed border-ink bg-paper2 p-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">
          {eyebrowLine(label, slice)}
        </span>
        <span className="font-mono text-[11px] text-inkSoft">{f.suggested.length} chars</span>
      </div>
      {f.note && <p className="mt-1 font-body text-[12px] text-inkSoft">{f.note}</p>}
      {hasSuggestion
        ? <p className="mt-1.5 font-body font-bold text-[13px] text-ink">{f.suggested}</p>
        : wasEmpty
          ? <p className="mt-1.5 font-body text-[13px] text-inkSoft">Nothing came back for this one — write it in your own words.</p>
          : <p className="mt-1.5 font-body text-[13px] text-inkSoft">Nothing to change — this one already fits.</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {hasSuggestion && (
          <button type="button"
            onClick={() => {
              patch({ [field]: f.suggested } as Partial<ListingDraft>);
              onSettled('applied');
              capture('listing_copy_review_apply', { field, source: slice.source ?? 'rules' });
            }}
            className={`${chipBase} bg-lime text-ink`}>
            Use this
          </button>
        )}
        <button type="button"
          onClick={() => {
            onSettled('kept');
            capture('listing_copy_review_keep', { field, source: slice.source ?? 'rules' });
          }}
          className={`${chipBase} bg-card text-inkSoft`}>
          {hasSuggestion ? (wasEmpty ? 'Not this one' : 'Keep mine') : 'Got it'}
        </button>
      </div>
    </div>
  );
}
