import { useEffect, useRef, useState } from 'react';
import Icon from '../Icon';
import type { GenerationStage, StepProps } from '../types';

const STAGES: { key: GenerationStage; label: string }[] = [
  { key: 'text', label: 'Writing your profile' },
  { key: 'images', label: 'Creating your avatar photos' },
  { key: 'voice', label: 'Copying your voice' },
  { key: 'conversation', label: 'Recording a sample conversation' },
  { key: 'safety', label: 'Safety check' },
];

export default function GeneratingStep({ draft, update, api, setAction, goNext }: StepProps) {
  const ran = useRef(false);
  const [current, setCurrent] = useState(-1);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => { setAction({ label: '', hidden: true }); }, [setAction]);

  useEffect(() => {
    if (draft.generated) { goNext(); return; }
    if (ran.current) return;
    ran.current = true;
    setError('');
    api.generateProfile(draft, st => setCurrent(STAGES.findIndex(s => s.key === st)))
      .then(g => { setCurrent(STAGES.length); update({ generated: g }); setTimeout(goNext, 400); })
      .catch(() => { ran.current = false; setError('Something went wrong while making your profile.'); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  return (
    <div className="hob-f-gen">
      <h1 className="hob-h1">Creating your profile</h1>
      <p className="hob-lead">This usually takes a few minutes. You can close this page — we'll send you a WhatsApp message when it's ready.</p>
      <ol className="hob-card hob-f-stages" aria-live="polite">
        {STAGES.map((s, i) => {
          const state = i < current ? 'done' : i === current ? 'working' : 'waiting';
          return (
            <li key={s.key} className={`hob-f-stage hob-f-stage-${state}`}>
              <span className="hob-f-stage-ico" aria-hidden="true">
                {state === 'done' ? <Icon name="check" /> : state === 'working' ? <span className="hob-f-spin" /> : null}
              </span>
              <span>{s.label}<span className="hob-f-sr"> — {state === 'done' ? 'done' : state === 'working' ? 'working' : 'waiting'}</span></span>
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
