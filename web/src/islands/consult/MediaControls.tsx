import { useTranslation as useUiTranslation } from "../../lib/i18n/react";
import { UiText } from "../../lib/i18n/react";
/*
 * MediaControls — the in-call control bar: mic toggle, camera toggle, leave, and
 * an optional "+15 min" extend. Money is NEVER computed here — extend/cancel just
 * call the Worker endpoints, which run the refund/settlement engine server-side
 * (PHASE-D step 5/6). `/complete` is host-driven and intentionally absent from
 * the fan UI; the fan handles the room ending via the WS `session_ended` event.
 */
import { useState } from 'react';

export interface MediaControlsProps {
  micOn: boolean;
  camOn: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onLeave: () => void;
  /** Show the extend action (host-only server-side; surfaced gracefully otherwise). */
  canExtend?: boolean;
  onExtend?: () => Promise<void> | void;
}

const round =
  'inline-flex h-12 w-12 items-center justify-center rounded-full border-zine border-ink ' +
  'shadow-zine-sm transition-transform duration-zine ease-out ' +
  'active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed';

export function MediaControls({
  micOn,
  camOn,
  onToggleMic,
  onToggleCam,
  onLeave,
  canExtend = false,
  onExtend,
}: MediaControlsProps) {
  const {t:uiT}=useUiTranslation("web-consult");

  const [extending, setExtending] = useState(false);

  const doExtend = async () => {
    if (!onExtend || extending) return;
    setExtending(true);
    try {
      await onExtend();
    } finally {
      setExtending(false);
    }
  };

  return (
    <div className="flex items-center justify-center gap-3">
      <button
        type="button"
        aria-pressed={!micOn}
        aria-label={micOn ? uiT("web-consult.2d1be6900bbed8f9","Mute microphone") : uiT("web-consult.a22cb32b07345be1","Unmute microphone")}
        title={micOn ? uiT("web-consult.8dd6857baf026850","Mute") : uiT("web-consult.ce4ee4efc5e324fc","Unmute")}
        onClick={onToggleMic}
        className={`${round} ${micOn ? 'bg-card text-ink' : 'bg-coral text-white'}`}
      >
        <span className="text-[20px] leading-none">{micOn ? '🎙️' : '🔇'}</span>
      </button>

      <button
        type="button"
        aria-pressed={!camOn}
        aria-label={camOn ? uiT("web-consult.2050f56db225c04a","Turn camera off") : uiT("web-consult.95e9fb569c93eb7b","Turn camera on")}
        title={camOn ? uiT("web-consult.ce3ef7450f8e26f1","Camera off") : uiT("web-consult.071a189a5dab8fff","Camera on")}
        onClick={onToggleCam}
        className={`${round} ${camOn ? 'bg-card text-ink' : 'bg-coral text-white'}`}
      >
        <span className="text-[20px] leading-none">{camOn ? '📷' : '🚫'}</span>
      </button>

      {canExtend && onExtend && (
        <button
          type="button"
          onClick={doExtend}
          disabled={extending}
          title={uiT("web-consult.af33e2b29effecad","Extend the session by 15 minutes")}
          className={
            'inline-flex h-12 items-center gap-2 rounded-full border-zine border-ink bg-blue px-5 ' +
            'font-display font-semibold text-[15px] text-ink shadow-zine-sm transition-transform duration-zine ease-out ' +
            'active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed disabled:opacity-60'
          }
        ><UiText id="web-consult.f28e175c19708b2d" source="+15 min" />{" "}</button>
      )}

      <button
        type="button"
        aria-label={uiT("web-consult.665cdc6c7748b142","Leave the call")}
        title={uiT("web-consult.fc6e4a408d56be96","Leave")}
        onClick={onLeave}
        className={
          'inline-flex h-12 items-center gap-2 rounded-full border-zine border-ink bg-coral px-6 ' +
          'font-display font-semibold text-[16px] text-white shadow-zine-sm transition-transform duration-zine ease-out ' +
          'active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed'
        }
      ><UiText id="web-consult.fc6e4a408d56be96" source="Leave" />{" "}</button>
    </div>
  );
}

export default MediaControls;
