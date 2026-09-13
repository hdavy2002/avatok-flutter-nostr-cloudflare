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
 * The file is a HOOK plus a small presentational component, not a panel:
 * `useCopyReview` owns the ONE POST /api/listings/copy-review call (the
 * endpoint returns all three fields at once, so three chips must never mean
 * three requests), and `CopyFieldAssist` renders one field's blip row from
 * that shared state.
 *
 * Four things this deliberately does NOT do:
 *
 *  1. It never edits the draft on its own. Each field gets its own "Use this".
 *     The words a creator publishes stay theirs to accept.
 *  2. It never claims an AI review that did not happen. The worker returns
 *     `source: 'ai' | 'rules'`; when the model is off or unreachable the row
 *     says so and the suggestions are the deterministic length fit.
 *  3. It does not block on the network to be useful. A failed call leaves the
 *     creator exactly where they were, with a retry AND an escape — see
 *     `failed` and the "Continue without AI" control in steps.tsx. An endpoint
 *     that is down must never be able to trap someone inside step 2.
 *  4. It does not re-run once a field is settled. `assisted` is checked by the
 *     caller before anything is offered, so a creator stepping back into step 2
 *     sees a quiet done state, not a fresh prompt.
 */
import { useCallback, useState } from 'react';
import { request } from '../../../lib/apiClient';
import { getActiveToken } from '../../../lib/clerk';
import { capture } from '../../../lib/analytics';
import type { ListingDraft } from './types';

interface ReviewField { original: string; suggested: string; note: string | null }
export interface CopyReviewResult {
  title: ReviewField;
  blurb: ReviewField;
  description: ReviewField;
  source: 'ai' | 'rules';
}

export type CopyField = 'title' | 'blurb' | 'description';

export interface CopyReviewState {
  result: CopyReviewResult | null;
  busy: boolean;
  error: string | null;
  /** True once a call has come back with an error — the escape hatch appears. */
  failed: boolean;
  run: () => Promise<void>;
}

/** The single shared fetch. One call returns all three fields. */
export function useCopyReview(draft: ListingDraft): CopyReviewState {
  const [result, setResult] = useState<CopyReviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const { title, blurb, description, kind, category, free_entry: freeEntry } = draft;

  const run = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const token = await getActiveToken();
      const r = await request<CopyReviewResult>('/api/listings/copy-review', {
        method: 'POST',
        auth: token ?? undefined,
        body: { title, blurb, description, kind, category, free_entry: freeEntry },
      });
      setResult(r);
      setFailed(false);
      capture('listing_copy_review_run', { source: r.source, kind, outcome: 'ok' });
    } catch {
      setError('Could not reach the AI check just now.');
      setFailed(true);
      capture('listing_copy_review_run', { kind, outcome: 'error' });
    } finally {
      setBusy(false);
    }
  }, [title, blurb, description, kind, category, freeEntry]);

  return { result, busy, error, failed, run };
}

const chipBase = 'rounded-zineField border-zine border-ink px-3 py-1.5 font-body font-bold text-[12px] shadow-zine-xs';

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
  const { result, busy, error } = state;
  const f = result?.[field] ?? null;

  if (assisted) {
    return (
      <p className="mb-1.5 font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkMute">
        ✓ AI checked
      </p>
    );
  }

  // Nothing back yet — the invitation. One press runs the single shared call,
  // so pressing it on any of the three fields fills in all three.
  if (!f) {
    return (
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">Use AI</span>
        <button type="button" disabled={busy} onClick={() => void state.run()}
          className={[chipBase, busy ? 'bg-paper2 text-inkMute' : 'bg-blue text-ink'].join(' ')}>
          {busy ? 'Asking Ava…' : `✦ Write my ${label.toLowerCase()} for me`}
        </button>
        {error && <span className="font-body font-bold text-[12px] text-coral">⚠ {error}</span>}
      </div>
    );
  }

  const changed = f.suggested !== f.original;
  return (
    <div className="mb-1.5 rounded-zine border-zine border-dashed border-ink bg-paper2 p-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">
          {result?.source === 'ai' ? `Ava’s ${label.toLowerCase()}` : `Length check only — Ava was unavailable`}
        </span>
        <span className="font-mono text-[11px] text-inkSoft">{f.suggested.length} chars</span>
      </div>
      {f.note && <p className="mt-1 font-body text-[12px] text-inkSoft">{f.note}</p>}
      {changed
        ? <p className="mt-1.5 font-body font-bold text-[13px] text-ink">{f.suggested}</p>
        : <p className="mt-1.5 font-body text-[13px] text-inkSoft">Nothing to change — this one already fits.</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {changed && (
          <button type="button"
            onClick={() => {
              patch({ [field]: f.suggested } as Partial<ListingDraft>);
              onSettled('applied');
              capture('listing_copy_review_apply', { field, source: result?.source ?? 'rules' });
            }}
            className={`${chipBase} bg-lime text-ink`}>
            Use this
          </button>
        )}
        <button type="button"
          onClick={() => {
            onSettled('kept');
            capture('listing_copy_review_keep', { field, source: result?.source ?? 'rules' });
          }}
          className={`${chipBase} bg-card text-inkSoft`}>
          {changed ? 'Keep mine' : 'Got it'}
        </button>
      </div>
    </div>
  );
}
