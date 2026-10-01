/* StudioKit — [AUMFE-POD-STUDIO-WEB-1 2026-10-01] Small shared pieces of the Studio screens: the five step pills,
 * the "All designs / Draft saved" row, and the design loader. Markup and classes are the mockup's
 * (Specs/studio-mockup/*.dc.html); CSS is studio.css, scoped under .studio-admin. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { captureException } from '../../../lib/analytics';
import { STEP_LABEL, STEP_ORDER, STUDIO_HOME, errMessage, getDesign, stepHref, type Design, type StudioStep } from '../../../lib/studioApi';
import './studio.css';

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
    <div className="steps">
      {STEP_ORDER.map((s, i) => {
        const done = s !== current && i < Math.max(furthest, STEP_ORDER.indexOf(current));
        return (
          <a key={s} className={s === current ? 'on' : done ? 'done' : ''} href={stepHref(id, s)} aria-current={s === current ? 'step' : undefined}>
            <b>{done ? '✓' : i + 1}</b>{STEP_LABEL[s]}
          </a>
        );
      })}
    </div>
  );
}

export function TopBar({ design }: { design: Design | null }) {
  return (
    <div className="topbar">
      <a className="btn ghost sm" href={STUDIO_HOME}>All designs</a>
      {design && <span className="chip">Draft saved · {design.name || 'Untitled'}</span>}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <div className="panel" role="status" aria-live="polite"><p className="lead" style={{ margin: 0 }}>{what}</p></div>;
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="panel" role="alert">
      <h2>That did not open</h2>
      <p className="lead">{message}</p>
      <div className="row"><button type="button" className="btn teal sm" onClick={onRetry}>Try again</button><a className="btn ghost sm" href={STUDIO_HOME}>All designs</a></div>
    </div>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return <div className="studio-admin">{children}</div>;
}

export function go(href: string): void {
  window.location.assign(href);
}
