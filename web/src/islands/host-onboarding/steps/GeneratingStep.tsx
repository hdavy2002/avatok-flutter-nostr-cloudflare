import { useEffect, useRef, useState } from 'react';
import Icon from '../Icon';
import type { GenerationStage, StageState, StageStates, StepProps } from '../types';

const STAGES: { key: GenerationStage; label: string }[] = [
  { key: 'text', label: 'Writing your profile' },
  { key: 'images', label: 'Creating your avatar photos' },
  { key: 'safety', label: 'Safety check' },
];

export default function GeneratingStep({ draft, update, api, setAction, goNext }: StepProps) {
  const ran = useRef(false);
  const [states, setStates] = useState<StageStates | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => { setAction({ label: '', hidden: true }); }, [setAction]);

  useEffect(() => {
    if (draft.generated) { goNext(); return; }
    if (ran.current) return;
    ran.current = true;
    setError('');
    api.generateProfile(draft, st => setStates(st))
      .then(g => { update({ generated: g }); setTimeout(goNext, 400); })
      .catch((e: unknown) => { ran.current = false; setError(e instanceof Error && e.message ? e.message : 'Something went wrong while making your profile.'); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  return (
    <div className="hob-f-gen">
      <h1 className="hob-h1">Creating your profile</h1>
      <p className="hob-lead">This usually takes a few minutes. You can close this page — we'll send you a WhatsApp message when it's ready.</p>
      <ol className="hob-card hob-f-stages" aria-live="polite">
        {STAGES.map((s) => {
          const state: StageState = states?.[s.key] ?? 'waiting';
          const skipped = state === 'skipped';
          const label = s.label;
          const css = state === 'skipped' ? 'done' : state === 'failed' ? 'waiting' : state;
          const word = state === 'done' ? 'done' : state === 'working' ? 'working' : state === 'skipped' ? 'skipped for now' : state === 'failed' ? 'failed' : 'waiting';
          return (
            <li key={s.key} className={`hob-f-stage hob-f-stage-${css}`}>
              <span className="hob-f-stage-ico" aria-hidden="true">
                {state === 'done' || skipped ? <Icon name="check" /> : state === 'working' ? <span className="hob-f-spin" /> : state === 'failed' ? <Icon name="x" /> : null}
              </span>
              <span>{label}<span className="hob-f-sr"> — {word}</span></span>
            </li>
          );
        })}
      </ol>
      {error && (
        <div aria-live="assertive">
          <p className="hob-error">{error}</p>
          <button type="button" className="hob-btn hob-btn-primary" onClick={() => setAttempt(n => n + 1)}>Try again</button>
        </div>
      )}
    </div>
  );
}
