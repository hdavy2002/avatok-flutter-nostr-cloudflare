// The auto-generated poster: preview + the state machine the owner asked
// for ("an auto-generated poster should be ready for me to preview and
// approve"). Polls the detail endpoint every ~4s while status=generating,
// stopping after ~2 minutes so a stuck generation doesn't poll forever.
import { useEffect, useRef, useState } from 'react';
import { Badge, fmt } from './adminListingsShared';
import type { PosterInfo } from './adminListingsShared';
import RejectControl from './RejectControl';
import { Spinner } from '../../components/Spinner';

const POLL_MS = 4000;
const POLL_MAX_ATTEMPTS = 30; // ~2 minutes

export default function PosterPanel({
  poster,
  listingTitle,
  busy,
  onGenerate,
  onRegenerate,
  onApprove,
  onReject,
  onPoll,
}: {
  poster: PosterInfo;
  listingTitle?: string | null;
  busy: boolean;
  onGenerate: () => void;
  onRegenerate: () => void;
  onApprove: () => void;
  onReject: (feedback: string) => void;
  onPoll: () => void;
}) {
  const status = poster?.status;
  const attemptsRef = useRef(0);
  const [pollTimedOut, setPollTimedOut] = useState(false);

  useEffect(() => {
    attemptsRef.current = 0;
    setPollTimedOut(false);
    if (status !== 'generating') return;
    const id = window.setInterval(() => {
      attemptsRef.current += 1;
      if (attemptsRef.current > POLL_MAX_ATTEMPTS) {
        setPollTimedOut(true);
        window.clearInterval(id);
        return;
      }
      onPoll();
    }, POLL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-[18px] font-semibold text-ink">Poster</h3>
        {status && (
          <Badge tone={
            status === 'approved' ? 'bg-mint text-mintInk'
              : status === 'rejected' || status === 'failed' ? 'bg-coral text-paper'
              : status === 'generating' ? 'bg-lilac text-ink'
              : 'bg-paper2 text-inkSoft'
          }>{status}</Badge>
        )}
      </div>

      <div className="mt-4">
        {!poster || !status ? (
          <div className="flex flex-col items-start gap-3">
            <div className="flex aspect-[3/4] w-full max-w-xs items-center justify-center rounded-zineField border-zine border-ink bg-paper2 font-body text-[14px] font-bold text-inkMute">
              No poster yet
            </div>
            <button type="button" disabled={busy} onClick={onGenerate} className="rounded-full border-zine border-ink bg-blue px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-paper shadow-zine-xs disabled:opacity-50">
              Generate poster
            </button>
          </div>
        ) : status === 'generating' ? (
          <div className="flex flex-col items-start gap-3">
            <div className="flex aspect-[3/4] w-full max-w-xs flex-col items-center justify-center gap-3 rounded-zineField border-zine border-ink bg-paper2">
              <Spinner size={28} />
              <span className="font-body text-[14px] font-bold text-inkSoft">Generating…</span>
            </div>
            {pollTimedOut && (
              <p className="font-body text-[13px] font-bold text-coral">Still generating after ~2 minutes — hit Refresh to keep checking, or investigate the poster job.</p>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <div className="relative w-full max-w-xs overflow-hidden rounded-zineField border-zine border-ink">
              {poster.url ? (
                <img src={poster.url} alt={`Auto-generated poster for ${listingTitle ?? 'this listing'}`} className="aspect-[3/4] w-full object-cover" />
              ) : (
                <div className="flex aspect-[3/4] w-full items-center justify-center bg-paper2 font-body text-[13px] font-bold text-inkMute">No preview image</div>
              )}
              {status === 'approved' && (
                <span className="absolute right-2 top-2 rounded-full border-zine border-ink bg-mint px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-mintInk">Approved</span>
              )}
            </div>

            <div className="grid gap-1 font-body text-[13px] font-bold text-inkSoft">
              <div>Attempt: <span className="text-ink">{poster.attempt ?? '—'}</span></div>
              <div>Source: <span className="text-ink">{poster.auto ? 'auto-generated on submit' : 'admin-triggered'}</span></div>
              <div>Completed: <span className="text-ink">{fmt(poster.completed_at)}</span></div>
              {status === 'failed' && poster.error && <div className="text-coral">Error: {poster.error}</div>}
              {status === 'rejected' && poster.feedback && <div>Feedback given: <span className="text-ink">{poster.feedback}</span></div>}
            </div>

            <div className="flex flex-wrap gap-2">
              {status === 'draft' && (
                <>
                  <button type="button" disabled={busy} onClick={onApprove} className="rounded-full border-zine border-ink bg-mint px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-mintInk shadow-zine-xs disabled:opacity-50">Approve poster</button>
                  <RejectControl label="Reject poster" placeholder="What needs to change before this poster can go out?" busy={busy} onConfirm={onReject} />
                </>
              )}
              {status === 'approved' ? (
                <span title="Regenerating an approved poster is blocked server-side — reject it first if it needs changes." className="rounded-full border-zine border-ink bg-paper2 px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-inkMute">
                  Regenerate (locked — poster is approved)
                </span>
              ) : (
                <button type="button" disabled={busy} onClick={onRegenerate} className="rounded-full border-zine border-ink bg-paper px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50">
                  Regenerate
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
