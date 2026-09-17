import { useTranslation as useUiTranslation } from "../../../lib/i18n/react";
import { UiText } from "../../../lib/i18n/react";
// SnapshotSheet — the "Analyze my form" result sheet.
//
// Renders the annotated frame Gemini returned (pixel-grounded), the optional
// score, and the prose breakdown. Pure presentation; SessionRoom owns the call,
// the in-flight state, and the snapshot cap. A 429 cap is shown as a calm
// fair-use notice (NO surprise charge — §B), never an error.

import { Sheet } from '../../../components/Sheet';
import { Spinner } from '../../../components/Spinner';
import type { SnapshotResult } from './avavisionApi';

export interface SnapshotSheetProps {
  open: boolean;
  loading: boolean;
  capReached: boolean;
  result: SnapshotResult | null;
  error: string | null;
  scoreLabel: string;
  remainingSnapshots: number | null;
  onClose: () => void;
}

export function SnapshotSheet({
  open,
  loading,
  capReached,
  result,
  error,
  scoreLabel,
  remainingSnapshots,
  onClose,
}: SnapshotSheetProps) {
  const {t:uiT}=useUiTranslation("web-vision");

  return (
    <Sheet open={open} onClose={onClose} title={uiT("web-vision.3849da149c946d2e","Form analysis")} dismissable={!loading}>
      {loading && (
        <div className="flex flex-col items-center gap-3 py-8">
          <Spinner size={28} color="var(--zine-lilac)" />
          <span className="font-mono font-bold uppercase text-[14px] tracking-[0.08em] text-inkSoft"><UiText id="web-vision.629f242f02e0bcc2" source="analyzing your form…" />{" "}</span>
        </div>
      )}

      {!loading && capReached && (
        <div className="flex flex-col items-center gap-2 rounded-zine border-zine border-ink bg-blue px-4 py-5 text-center shadow-zine-xs">
          <span className="font-display font-semibold text-[18px] text-ink"><UiText id="web-vision.75c61a6bc6797fbf" source="You've used all your form checks" /></span>
          <p className="font-body font-bold text-[14px] text-inkSoft"><UiText id="web-vision.fd82ea3de856be6b" source="This session's deep analyses are used up — no extra charge. Keep going with the live coaching, or start a new session for more." />{" "}</p>
        </div>
      )}

      {!loading && !capReached && error && (
        <div className="rounded-zine border-zine border-ink bg-card px-4 py-4 text-center shadow-zine-xs">
          <p className="font-body font-bold text-[14px] text-coral">{error}</p>
        </div>
      )}

      {!loading && !capReached && !error && result && (
        <div className="flex flex-col gap-4">
          {result.annotatedImage && (
            <img
              src={result.annotatedImage}
              alt={uiT("web-vision.4969badd45459223","Annotated analysis of your form")}
              className="w-full rounded-zine border-zine border-ink shadow-zine-sm"
            />
          )}
          {result.score != null && (
            <span className="inline-flex w-fit items-center gap-2 rounded-full border-zine border-ink bg-lime px-3 py-1 font-mono font-bold uppercase text-[14px] tracking-[0.08em] text-ink shadow-zine-xs">
              {scoreLabel} {result.score}
            </span>
          )}
          {result.breakdown && (
            <p className="whitespace-pre-wrap font-body font-bold text-[15px] leading-snug text-ink">
              {result.breakdown}
            </p>
          )}
          {remainingSnapshots != null && (
            <p className="font-body text-[12px] text-inkMute">
              {remainingSnapshots > 0
                ? uiT("web-vision.cb9be7f19a300ed2","{value0} form check{value1} left this session.",{value0:String(remainingSnapshots),value1:String(remainingSnapshots === 1 ? '' : 's')})
                : uiT("web-vision.c56c835c54dfa77c","No more form checks this session.")}
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}

export default SnapshotSheet;
