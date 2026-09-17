import { useTranslation as useUiTranslation } from "../../lib/i18n/react";
import { UiText } from "../../lib/i18n/react";
// Live viewer count + connection pill. Pure presentation — the count comes
// from the shared room socket (room.ts `viewers`, fed by the DO's `welcome` /
// `viewers` events). PHASE-C §5.
import type { RoomConnState } from './room';

export interface ViewerCountProps {
  viewers: number;
  conn: RoomConnState;
  hostLive: boolean;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function ViewerCount({ viewers, conn, hostLive }: ViewerCountProps) {
  const {t:uiT}=useUiTranslation("web-live");

  const live = hostLive && conn === 'open';
  return (
    <div className="inline-flex items-center gap-2 rounded-full border-zine border-ink bg-card px-3 py-1.5 shadow-zine-xs">
      <span
        className={['inline-block h-2.5 w-2.5 rounded-full', live ? 'bg-coral' : 'bg-inkMute'].join(' ')}
        style={live ? { animation: 'zine-pulse 1.4s ease-in-out infinite' } : undefined}
        aria-hidden
      />
      <span className="font-mono font-bold uppercase text-[14px] tracking-[0.06em] text-ink">
        {live ? uiT("web-live.b64ac05f17e64d03","Live") : conn === 'reconnecting' ? uiT("web-live.afb118fcb16c3727","Reconnecting") : uiT("web-live.a1794783aab72d20","Offline")}
      </span>
      <span className="font-mono text-[14px] text-inkSoft tabular-nums font-bold">
        · {fmt(viewers)}{" "}<UiText id="web-live.19bda4aa00eaf9a1" source="watching" />{" "}</span>
      <style>{uiT("web-live.eb3bb1a7cb30aae1","@keyframes zine-pulse{0%,100%{opacity:1}50%{opacity:.35}}")}</style>
    </div>
  );
}

export default ViewerCount;
