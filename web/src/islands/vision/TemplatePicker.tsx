// TemplatePicker — step 1 of the studio: Category grid → Use-Case cards.
//
// Template-first flow, identical to the app (MASTER §6 / Phase 2): the creator
// picks a Category, then a Use-Case template; the chosen template prefills the
// AgentForm (capability / overlay / scoring / score label / starter prompt /
// snapshot cap / platforms). Reads GET /api/avavision/templates?platform=web.

import { useEffect, useState } from 'react';
import { Spinner } from '../../components/Spinner';
import { Pill } from '../../components/Pill';
import { getTemplates, type VisionCategory, type VisionTemplate } from './avavisionApi';

export interface TemplatePickerProps {
  onPick: (category: VisionCategory, template: VisionTemplate) => void;
}

export function TemplatePicker({ onPick }: TemplatePickerProps) {
  const [cats, setCats] = useState<VisionCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await getTemplates('web');
        if (cancelled) return;
        setCats(c);
        setActive(c[0]?.id ?? null);
      } catch {
        if (!cancelled) setError('Could not load templates. Please refresh.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-inkSoft">
        <Spinner size={22} /> <span className="font-body font-bold text-[15px]">Loading templates…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-zine border-zine border-coral bg-card p-4 font-body font-bold text-[15px] text-ink shadow-zine-error">
        {error}
      </div>
    );
  }

  const current = cats.find((c) => c.id === active) ?? cats[0];

  return (
    <div className="flex flex-col gap-6">
      {/* Category chips */}
      <div>
        <p className="mb-2 font-mono font-bold uppercase text-[11px] tracking-[0.1em] text-blueInk">
          1 · Pick a category
        </p>
        <div className="flex flex-wrap gap-2">
          {cats.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActive(c.id)}
              className={[
                'rounded-full border-zine border-ink px-4 py-2 font-display font-semibold text-[15px] shadow-zine-xs',
                'transition-transform duration-zine active:translate-x-[1px] active:translate-y-[1px] active:shadow-zine-pressed',
                c.id === active ? 'bg-lime text-ink' : 'bg-card text-inkSoft',
              ].join(' ')}
            >
              {c.name}
            </button>
          ))}
        </div>
        {current?.tagline && (
          <p className="mt-2 font-body font-bold text-[14px] text-inkSoft">{current.tagline}</p>
        )}
      </div>

      {/* Use-case cards */}
      <div>
        <p className="mb-2 font-mono font-bold uppercase text-[11px] tracking-[0.1em] text-blueInk">
          2 · Pick a use-case
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {current?.templates.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onPick(current, t)}
              className={[
                'group rounded-zine border-zine border-ink bg-card p-4 text-left shadow-zine-sm',
                'transition-transform duration-zine hover:-translate-x-[1px] hover:-translate-y-[1px]',
                'active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed',
              ].join(' ')}
            >
              <h3 className="font-display font-semibold text-[18px] leading-tight text-ink">{t.name}</h3>
              <p className="mt-1 font-body font-bold text-[13px] text-inkSoft line-clamp-2">
                {t.trackedSubject ? `Tracks ${t.trackedSubject}.` : t.starterPrompt}
              </p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {t.overlayEnabled && <Pill kind="hint">Overlay</Pill>}
                {t.scoreLabel && <Pill kind="hint">{t.scoreLabel}</Pill>}
                {t.freeSnapshotsPerSession ? <Pill kind="hint">Snapshot</Pill> : null}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default TemplatePicker;
