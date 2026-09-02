/* [CARD-AI-REVIEW-1 2026-09-03, owner decision] The pre-publish copy review.
 *
 * Owner's ask: every card is reviewed by AI while the form is being filled —
 * the title is sized to the card, the description is grown or trimmed — so the
 * grid stops looking like some tiles were finished and others abandoned.
 *
 * Three things this panel deliberately does NOT do:
 *
 *  1. It never edits the draft on its own. Each field gets its own "Use this"
 *     button. The words a creator publishes stay theirs to accept.
 *  2. It never claims an AI review that did not happen. The worker returns
 *     `source: 'ai' | 'rules'`; when the model is off or unreachable the badge
 *     says so and the suggestions are the deterministic length fit.
 *  3. It does not block on the network to be useful. A failed call leaves the
 *     creator exactly where they were, with a retry.
 */
import { useCallback, useState } from 'react';
import { request } from '../../../lib/apiClient';
import { getActiveToken } from '../../../lib/clerk';
import { capture } from '../../../lib/analytics';
import { Button, Card } from '../../../components';
import type { ListingDraft } from './types';

interface ReviewField { original: string; suggested: string; note: string | null }
export interface CopyReviewResult {
  title: ReviewField;
  blurb: ReviewField;
  description: ReviewField;
  source: 'ai' | 'rules';
}

export function CopyReview({
  draft, patch, onReviewed,
}: {
  draft: ListingDraft;
  patch: (p: Partial<ListingDraft>) => void;
  /** Fired once a review has come back, so the publish checklist can tick. */
  onReviewed: () => void;
}) {
  const [result, setResult] = useState<CopyReviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<Record<string, boolean>>({});

  const run = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const token = await getActiveToken();
      const r = await request<CopyReviewResult>('/api/listings/copy-review', {
        method: 'POST',
        auth: token ?? undefined,
        body: {
          title: draft.title, blurb: draft.blurb, description: draft.description,
          kind: draft.kind, category: draft.category, free_entry: draft.free_entry,
        },
      });
      setResult(r);
      setApplied({});
      onReviewed();
      capture('listing_copy_review_run', { source: r.source, kind: draft.kind });
    } catch {
      setError('Could not run the review just now. Try again.');
    } finally {
      setBusy(false);
    }
  }, [draft.title, draft.blurb, draft.description, draft.kind, draft.category, draft.free_entry, onReviewed]);

  const rows: { key: 'title' | 'blurb' | 'description'; label: string }[] = [
    { key: 'title', label: 'Title' },
    { key: 'blurb', label: 'Blurb' },
    { key: 'description', label: 'Description' },
  ];

  return (
    <Card fillClassName="bg-paper2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-body font-bold text-[14px] text-ink">Ava reviews your copy</p>
          <p className="font-body text-[12px] text-inkSoft">
            Sizes the title to the card, and grows or trims the description. Suggestions only — you choose.
          </p>
        </div>
        <Button variant="blue" label={result ? 'Review again' : 'Review my copy'} loading={busy} onClick={() => void run()} />
      </div>

      {error && <p className="mt-3 font-body font-bold text-[13px] text-coral">⚠ {error}</p>}

      {result && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">
            {result.source === 'ai' ? 'Reviewed by Ava' : 'Length check only — Ava was unavailable'}
          </p>
          {rows.map(({ key, label }) => {
            const f = result[key];
            const changed = f.suggested !== f.original;
            return (
              <div key={key} className="border-t-2 border-dashed border-ink/25 pt-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">{label}</span>
                  <span className="font-mono text-[11px] text-inkSoft">{f.suggested.length} chars</span>
                </div>
                {f.note && <p className="mt-1 font-body text-[12px] text-inkSoft">{f.note}</p>}
                {changed ? (
                  <>
                    <p className="mt-1.5 font-body font-bold text-[13px] text-ink">{f.suggested}</p>
                    <div className="mt-2 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          patch({ [key]: f.suggested } as Partial<ListingDraft>);
                          setApplied((a) => ({ ...a, [key]: true }));
                          capture('listing_copy_review_apply', { field: key, source: result.source });
                        }}
                        className="rounded-zineField border-zine border-ink bg-lime px-3 py-1.5 font-body font-bold text-[12px] text-ink shadow-zine-xs"
                      >
                        Use this
                      </button>
                      {applied[key] && <span className="font-body font-bold text-[12px] text-inkSoft">Applied ✓</span>}
                    </div>
                  </>
                ) : (
                  <p className="mt-1.5 font-body text-[13px] text-inkSoft">Nothing to change — this one already fits.</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export default CopyReview;
