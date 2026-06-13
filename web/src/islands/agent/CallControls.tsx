// CallControls — the in-call control bar (mic / vision / hang-up) + timer +
// status sticker. Pure presentation; AgentCall owns all state & lifecycle.
// zine look: bordered control circles, hard shadows, coral hang-up.

export type CallPhase =
  | 'idle'
  | 'authing'
  | 'starting'
  | 'connecting'
  | 'live'
  | 'wrapup'
  | 'ended'
  | 'error';

export interface CallControlsProps {
  phase: CallPhase;
  muted: boolean;
  visionEnabled: boolean;
  visionOn: boolean;
  agentSpeaking: boolean;
  remainingLabel: string;
  alert: boolean; // wrap-up styling on the timer
  onToggleMute: () => void;
  onToggleVision: () => void;
  onHangup: () => void;
}

function circle(active: boolean, danger: boolean, large: boolean): string {
  const fill = danger ? 'bg-coral text-white' : active ? 'bg-lime text-ink' : 'bg-card text-ink';
  const size = large ? 'h-16 w-16' : 'h-[52px] w-[52px]';
  return [
    'inline-flex items-center justify-center rounded-full border-zine border-ink select-none',
    large ? 'shadow-zine-sm' : 'shadow-zine-xs',
    'transition-transform duration-zine ease-out active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed',
    'disabled:opacity-50',
    size,
    fill,
  ].join(' ');
}

export function CallControls({
  phase,
  muted,
  visionEnabled,
  visionOn,
  remainingLabel,
  alert,
  onToggleMute,
  onToggleVision,
  onHangup,
}: CallControlsProps) {
  const liveish = phase === 'live' || phase === 'wrapup';
  const ended = phase === 'ended' || phase === 'error';

  return (
    <div className="flex flex-col items-center gap-5">
      {/* Timer chip */}
      <span
        className={[
          'inline-flex items-center gap-2 rounded-full border-zine border-ink px-3.5 py-1.5 shadow-zine-xs',
          alert ? 'bg-coral text-white' : 'bg-card text-ink',
          'font-mono font-bold uppercase text-[12px] tracking-[0.08em]',
        ].join(' ')}
      >
        ⏱ {liveish ? remainingLabel : '--:--'}
      </span>

      {/* Controls */}
      <div className="flex items-center justify-center gap-4">
        {visionEnabled && (
          <button
            type="button"
            aria-label={visionOn ? 'Stop sharing video' : 'Share camera or screen'}
            className={circle(visionOn, false, false)}
            disabled={!liveish}
            onClick={onToggleVision}
          >
            <span className="text-[20px] leading-none">{visionOn ? '📹' : '🎥'}</span>
          </button>
        )}

        <button
          type="button"
          aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
          className={circle(muted, false, false)}
          disabled={!liveish}
          onClick={onToggleMute}
        >
          <span className="text-[20px] leading-none">{muted ? '🔇' : '🎙'}</span>
        </button>

        <button
          type="button"
          aria-label={ended ? 'Close' : 'End call'}
          className={circle(false, true, true)}
          onClick={onHangup}
        >
          <span className="text-[24px] leading-none">{ended ? '✕' : '📞'}</span>
        </button>
      </div>
    </div>
  );
}

export default CallControls;
