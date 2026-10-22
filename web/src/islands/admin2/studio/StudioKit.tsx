/* StudioKit — [AUMFE-POD-STUDIO-WEB-1 2026-10-01] Small shared pieces of the Studio screens: the five-step journey,
 * the "All designs / Draft saved" row, and the design loader. Look: the desi admin kit (admin2/desi.tsx); CSS is studio.css, scoped under .studio-admin. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { captureException } from '../../../lib/analytics';
import { STEP_LABEL, STEP_ORDER, STUDIO_HOME, errMessage, getDesign, stepHref, type Design, type StudioStep } from '../../../lib/studioApi';
import { DesiCard, DesiChip, DesiJourney, Marigold } from '../desi';
import './studio.css';

/** Medallion colour per step: Upload rani, Product lav, Place gold, Photos tea, Publish plum. */
export const STEP_TONE: Record<StudioStep, 'rani' | 'lav' | 'gold' | 'tea' | 'plum'> = {
  upload: 'rani', product: 'lav', design: 'gold', photos: 'tea', publish: 'plum',
};

export function useDesign(id: string | null): {
  design: Design | null; setDesign: (d: Design) => void; error: string | null; reload: () => Promise<Design | null>;
} {
  const [design, setDesign] = useState<Design | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async (): Promise<Design | null> => {
    if (!id) return null;
    try {
      const d = await getDesign(id);
      setDesign(d); setError(null);
      return d;
    } catch (e) {
      captureException(e, { where: 'studio_get_design' });
      setError(errMessage(e, 'Could not open this design.'));
      return null;
    }
  }, [id]);
  useEffect(() => { void reload(); }, [reload]);
  return { design, setDesign, error, reload };
}

export function Steps({ id, current, design }: { id: string | null; current: StudioStep; design: Design | null }) {
  const furthest = design ? STEP_ORDER.indexOf(design.step) : -1;
  return (
    <DesiCard tone="cream" pattern="dots" corner="marigold" className="sa-journey-card">
      <DesiJourney
        label="Design steps"
        steps={STEP_ORDER.map((s, i) => {
          const done = s !== current && i < Math.max(furthest, STEP_ORDER.indexOf(current));
          return {
            tone: STEP_TONE[s],
            done,
            icon: done ? '✓' : i + 1,
            title: (
              <a className={`sa-stop-link${s === current ? ' on' : ''}`} href={stepHref(id, s)} aria-current={s === current ? 'step' : undefined}>{STEP_LABEL[s]}</a>
            ),
          };
        })}
      />
    </DesiCard>
  );
}

export function TopBar({ design }: { design: Design | null }) {
  return (
    <div className="topbar">
      <a className="hfa-btn ghost sm" href={STUDIO_HOME}>All designs</a>
      {design && <DesiChip tone="gold"><Marigold size={16} />Draft saved · {design.name || 'Untitled'}</DesiChip>}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <DesiCard tone="cream" corner="jasmine"><p className="sa-lead" role="status" aria-live="polite">{what}</p></DesiCard>;
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <DesiCard tone="rani" corner="hibiscus" title="That did not open">
      <div role="alert"><p className="sa-lead">{message}</p>
        <div className="row"><button type="button" className="hfa-btn sm" onClick={onRetry}>Try again</button><a className="hfa-btn ghost sm" href={STUDIO_HOME}>All designs</a></div></div>
    </DesiCard>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return <div className="studio-admin hfa-stack">{children}</div>;
}

export function go(href: string): void {
  window.location.assign(href);
}
