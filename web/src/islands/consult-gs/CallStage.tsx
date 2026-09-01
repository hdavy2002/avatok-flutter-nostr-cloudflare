/*
 * CallStage — the in-call GetStream view for the 1:1 consult
 * (SPEC-2026-09-01 §4.4). Wraps a joined `Call` in `<StreamCall>` so the
 * SDK's state hooks (`useCallStateHooks`) have context, then renders:
 *   - both parties' video (remote main stage, local PiP), via the SDK's own
 *     `ParticipantView` — which already falls back to an avatar when a
 *     track is disabled, so "camera off" needs no bespoke handling here.
 *   - mic / camera toggles, backed by the Call's own device managers
 *     (never a hand-rolled MediaStream — the SDK owns capture once joined).
 *   - a visible countdown to the booked end (`endsAt`), first-class per the
 *     spec: the buyer is paying for a block of time and must see it running
 *     out. Reaching zero ends the call.
 *   - the extend-time entry point (ExtendPanel), which updates `endsAt` on
 *     success via `onEndsAtChange`.
 *   - a "Reconnecting…" banner driven by the SDK's own `CallingState`, with
 *     a manual retry once it gives up (`RECONNECTING_FAILED`).
 *
 * Imports the SDK's stylesheet — required for `ParticipantView` video
 * sizing/object-fit. This island is the only page that hydrates this
 * component, so importing it here does not add weight to any other page.
 */
import '@stream-io/video-react-sdk/dist/css/styles.css';
import { useEffect, useState } from 'react';
import {
  StreamCall,
  ParticipantView,
  CallingState,
  useCallStateHooks,
  type Call,
} from '@stream-io/video-react-sdk';
import { Spinner } from '../../components';
import { Countdown } from './Countdown';
import { ExtendPanel } from './ExtendPanel';

export interface CallStageProps {
  call: Call;
  bookingId: string;
  jwt: string;
  role: 'creator' | 'buyer';
  peerName: string;
  title: string;
  endsAt: number;
  onEndsAtChange: (ms: number) => void;
  /** Called once, when the user (or a fatal state) ends the call. */
  onLeave: (reason: string) => void;
}

const HUD: Record<string, { label: string; cls: string } | null> = {
  [CallingState.JOINING]: { label: 'Connecting…', cls: 'border-ink bg-card text-inkSoft' },
  [CallingState.JOINED]: null,
  [CallingState.RECONNECTING]: { label: 'Reconnecting…', cls: 'border-coral bg-card text-coral shadow-zine-error' },
  [CallingState.RECONNECTING_FAILED]: { label: 'Connection lost', cls: 'border-coral bg-card text-coral shadow-zine-error' },
};

function CallStageInner({ call, bookingId, jwt, role, peerName, title, endsAt, onEndsAtChange, onLeave }: CallStageProps) {
  const { useLocalParticipant, useRemoteParticipants, useCameraState, useMicrophoneState, useCallCallingState } =
    useCallStateHooks();
  const local = useLocalParticipant();
  const remote = useRemoteParticipants()[0];
  const cam = useCameraState();
  const mic = useMicrophoneState();
  const callingState = useCallCallingState();
  const [showExtend, setShowExtend] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice((n) => (n === m ? null : n)), 4000);
  };

  // Peer ended, timed out server-side, or a terminal disconnect — never our
  // own deliberate leave (that path calls onLeave directly and tears down
  // before this can observe LEFT).
  useEffect(() => {
    if (callingState === CallingState.LEFT) {
      onLeave('The session has ended.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callingState]);

  const hud = HUD[callingState] ?? null;

  const retryConnection = async () => {
    setRetrying(true);
    try {
      await call.join();
    } catch {
      flash('Still could not reconnect. Check your connection.');
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="relative mx-auto flex h-[calc(100dvh-4rem)] max-w-6xl flex-col gap-3 px-3 py-3">
      {/* top bar */}
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="mr-auto font-display font-semibold text-[18px] text-ink">{title}</h1>
        {hud && (
          <span className={`rounded-zine-badge border-zine px-3 py-1.5 font-mono font-bold text-[12px] ${hud.cls}`}>
            {hud.label}
          </span>
        )}
        {callingState === CallingState.RECONNECTING_FAILED && (
          <button
            type="button"
            onClick={() => void retryConnection()}
            disabled={retrying}
            className="rounded-zine-badge border-zine border-ink bg-blue px-3 py-1.5 font-display font-semibold text-[13px] text-ink disabled:opacity-60"
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
        <Countdown target={endsAt} label="Ends in" onZero={() => onLeave('Time is up.')} />
      </div>

      {/* stage */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-zine border-zine border-ink bg-ink shadow-zine">
        {remote ? (
          <ParticipantView participant={remote} trackType="videoTrack" className="h-full w-full" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-paper2 text-center">
            <Spinner size={28} />
            <p className="font-body font-bold text-[15px] text-inkSoft">Waiting for {peerName}…</p>
          </div>
        )}

        {/* local PiP */}
        <div className="absolute bottom-3 right-3 aspect-[3/4] w-28 overflow-hidden rounded-zine border-zine border-ink bg-ink shadow-zine-sm sm:w-36">
          {local && <ParticipantView participant={local} trackType="videoTrack" className="h-full w-full" />}
        </div>

        {notice && (
          <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-zine-badge border-zine border-ink bg-card px-3 py-1.5 font-body font-bold text-[13px] text-ink shadow-zine-xs">
            {notice}
          </div>
        )}

        {showExtend && (
          <ExtendPanel
            bookingId={bookingId}
            jwt={jwt}
            role={role}
            onClose={() => setShowExtend(false)}
            onExtended={(newEnd) => {
              onEndsAtChange(newEnd);
              setShowExtend(false);
              flash('Session extended.');
            }}
          />
        )}
      </div>

      {/* controls */}
      <div className="flex items-center justify-center gap-3 pt-1">
        <button
          type="button"
          aria-pressed={mic.isMute}
          aria-label={mic.isMute ? 'Unmute microphone' : 'Mute microphone'}
          onClick={() => void mic.microphone.toggle()}
          className={[
            'inline-flex h-12 w-12 items-center justify-center rounded-full border-zine border-ink shadow-zine-sm',
            'transition-transform duration-zine ease-out active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed',
            mic.isMute ? 'bg-coral text-white' : 'bg-card text-ink',
          ].join(' ')}
        >
          <span className="text-[20px] leading-none">{mic.isMute ? '🔇' : '🎙️'}</span>
        </button>

        <button
          type="button"
          aria-pressed={cam.isMute}
          aria-label={cam.isMute ? 'Turn camera on' : 'Turn camera off'}
          onClick={() => void cam.camera.toggle()}
          className={[
            'inline-flex h-12 w-12 items-center justify-center rounded-full border-zine border-ink shadow-zine-sm',
            'transition-transform duration-zine ease-out active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed',
            cam.isMute ? 'bg-coral text-white' : 'bg-card text-ink',
          ].join(' ')}
        >
          <span className="text-[20px] leading-none">{cam.isMute ? '🚫' : '📷'}</span>
        </button>

        <button
          type="button"
          onClick={() => setShowExtend(true)}
          title="Extend the session"
          className={
            'inline-flex h-12 items-center gap-2 rounded-full border-zine border-ink bg-blue px-5 ' +
            'font-display font-semibold text-[15px] text-ink shadow-zine-sm transition-transform duration-zine ease-out ' +
            'active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed'
          }
        >
          Extend
        </button>

        <button
          type="button"
          aria-label="Leave the call"
          onClick={() => onLeave('You left the session.')}
          className={
            'inline-flex h-12 items-center gap-2 rounded-full border-zine border-ink bg-coral px-6 ' +
            'font-display font-semibold text-[16px] text-white shadow-zine-sm transition-transform duration-zine ease-out ' +
            'active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed'
          }
        >
          Leave
        </button>
      </div>
    </div>
  );
}

/** Public entry: wraps the joined Call in StreamCall so the hooks above have context. */
export function CallStage(props: CallStageProps) {
  return (
    <StreamCall call={props.call}>
      <CallStageInner {...props} />
    </StreamCall>
  );
}

export default CallStage;
