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

// [POSTER-PROGRESS-1 2026-09-05] What the admin sees while the job runs. These
// are HONEST stage labels in the order the pipeline actually executes
// (worker/src/lib/listing_poster.ts): paint the portrait, read the lettering
// back, then reframe to tablet and wide. They are timed, not reported — the
// synchronous admin route returns nothing until it is finished — so they are
// deliberately worded as "what it is doing now", never as a percentage or a
// completed tick, which would be a fabricated claim about a job we cannot see
// into. A real observed run took 41s end to end.
const STAGES: { at: number; label: string }[] = [
  { at: 0, label: 'Painting the poster…' },
  { at: 12, label: 'Reading the lettering back…' },
  { at: 25, label: 'Reframing for tablet and wide…' },
  { at: 55, label: 'Still working — this one is taking longer than usual…' },
];

function stageFor(seconds: number): string {
  let label = STAGES[0].label;
  for (const s of STAGES) if (seconds >= s.at) label = s.label;
  return label;
}

export default function PosterPanel({
  poster,
  listingTitle,
  busy,
  running = false,
  actionError = null,
  onGenerate,
  onRegenerate,
  onApprove,
  onReject,
  onPoll,
}: {
  poster: PosterInfo;
  listingTitle?: string | null;
  busy: boolean;
  /** A poster generation is in flight from THIS panel right now. Distinct from
   *  `status === 'generating'`: the admin regenerate route runs synchronously,
   *  so it never writes a `generating` row — it goes straight from the old
   *  state to the new one, ~40-60s later, with nothing in between. Without
   *  this the card sat on "FAILED" for the whole minute. */
  running?: boolean;
  /** The last poster action's failure, shown on the card. */
  actionError?: string | null;
  onGenerate: () => void;
  onRegenerate: () => void;
  onApprove: () => void;
  onReject: (feedback: string) => void;
  onPoll: () => void;
}) {
  const status = poster?.status;
  const attemptsRef = useRef(0);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // Either kind of in-flight: our own synchronous request, or a detached
  // auto-generation that left the row on `generating`.
  const inFlight = running || status === 'generating';

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

  // A ticking second count is the point: a spinner alone cannot distinguish
  // "working" from "frozen", which is exactly the doubt this panel is fixing.
  useEffect(() => {
    if (!inFlight) { setElapsed(0); return; }
    setElapsed(0);
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [inFlight]);

  return (
    <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-[18px] font-semibold text-ink">Poster</h3>
        {inFlight ? (
          // While a job is running the badge must NOT keep showing the previous
          // terminal state. The stale "FAILED" chip sitting above a spinner is
          // the exact thing that made a successful regenerate look dead.
          <Badge tone="bg-lilac text-ink">generating</Badge>
        ) : status ? (
          <Badge tone={
            status === 'approved' ? 'bg-mint text-mintInk'
              : status === 'rejected' || status === 'failed' ? 'bg-coral text-paper'
              : 'bg-paper2 text-inkSoft'
          }>{status}</Badge>
        ) : null}
      </div>

      <div className="mt-4">
        {inFlight ? (
          <div className="flex flex-col items-start gap-3">
            <div className="poster-working flex aspect-[3/4] w-full max-w-xs flex-col items-center justify-center gap-3 rounded-zineField border-zine border-ink">
              <Spinner size={28} />
              <span className="px-4 text-center font-body text-[14px] font-bold text-inkSoft">
                {stageFor(elapsed)}
              </span>
              <span className="font-mono text-[12px] font-bold tracking-[0.08em] text-inkMute">
                {elapsed}s
              </span>
            </div>
            <p className="max-w-xs font-body text-[13px] font-bold text-inkSoft">
              Usually about 40 seconds. Leave this page open — the panel refreshes itself
              when the job lands, whether it worked or not.
            </p>
            {pollTimedOut && (
              <p className="font-body text-[13px] font-bold text-coral">Still generating after ~2 minutes — hit Refresh to keep checking, or investigate the poster job.</p>
            )}
            <style>{`
              /* A slow sweep across the empty frame, so the panel is visibly
                 alive even at the moments the spinner is between frames.
                 prefers-reduced-motion turns it into a flat field: the
                 second counter above still carries the "it is working"
                 signal, so nothing is lost by removing the movement. */
              .poster-working {
                background: linear-gradient(100deg,
                  var(--zine-paper2, #EFDCC2) 30%,
                  var(--zine-paper, #F6E4CD) 50%,
                  var(--zine-paper2, #EFDCC2) 70%);
                background-size: 300% 100%;
                animation: posterSweep 2.4s ease-in-out infinite;
              }
              @keyframes posterSweep {
                0% { background-position: 150% 0; }
                100% { background-position: -50% 0; }
              }
              @media (prefers-reduced-motion: reduce) {
                .poster-working { animation: none; background: var(--zine-paper2, #EFDCC2); }
              }
            `}</style>
          </div>
        ) : actionError ? (
          <div className="flex flex-col items-start gap-3">
            <div className="flex aspect-[3/4] w-full max-w-xs items-center justify-center rounded-zineField border-zine border-ink bg-paper2 px-4 text-center font-body text-[14px] font-bold text-coral">
              {actionError}
            </div>
            <p className="max-w-xs font-body text-[13px] font-bold text-inkSoft">
              The request failed. The state below is what the server actually holds — it was
              re-read after the failure, so if the job finished anyway you are seeing that.
            </p>
            <button type="button" disabled={busy} onClick={onRegenerate} className="rounded-full border-zine border-ink bg-paper px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50">
              Try again
            </button>
          </div>
        ) : !poster || !status ? (
          <div className="flex flex-col items-start gap-3">
            <div className="flex aspect-[3/4] w-full max-w-xs items-center justify-center rounded-zineField border-zine border-ink bg-paper2 font-body text-[14px] font-bold text-inkMute">
              No poster yet
            </div>
            <button type="button" disabled={busy} onClick={onGenerate} className="rounded-full border-zine border-ink bg-blue px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-paper shadow-zine-xs disabled:opacity-50">
              Generate poster
            </button>
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
