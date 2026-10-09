import { useEffect } from 'react';
import { contactLeak } from '../data';
import type { StepProps } from '../types';

const EXAMPLES = [
  'I love listening to people and I never judge.',
  'I like old songs, cooking and a good cup of chai.',
  'I have lived in a big city and a small town, so I understand both.',
];

export default function AboutStep({ draft, update, setAction }: StepProps) {
  const name = draft.displayName.trim();
  const nameOk = /^[A-Za-zऀ-ॿ ]{2,20}$/.test(name);
  const len = draft.about.trim().length;
  const leak = contactLeak(draft.about) || contactLeak(draft.displayName);
  const aboutOk = len >= 40 && len <= 500 && !leak;
  const valid = nameOk && aboutOk;

  useEffect(() => {
    setAction({ label: 'Continue', disabled: !valid, run: () => true });
  }, [valid]); // eslint-disable-line react-hooks/exhaustive-deps

  const addExample = (t: string) => {
    const cur = draft.about.trim();
    const next = cur ? `${cur} ${t}` : t;
    update({ about: next.slice(0, 500) });
  };

  return (
    <div className="hob-p-step">
      <h1 className="hob-h1">About you</h1>
      <p className="hob-lead">Callers pick a host by reading this. Keep it warm and simple.</p>

      <div className="hob-field">
        <label className="hob-label" htmlFor="hob-name">First name</label>
        <input id="hob-name" className="hob-input" type="text" autoComplete="given-name" maxLength={20}
          value={draft.displayName} onChange={(e) => update({ displayName: e.target.value })} placeholder="For example, Neha" />
        <p className="hob-help">Only your first name is shown. You can use a nickname.</p>
        {draft.displayName && !nameOk && <p className="hob-error" role="alert">Use 2 to 20 letters. No numbers or symbols.</p>}
      </div>

      <div className="hob-field">
        <label className="hob-label" htmlFor="hob-about">Tell callers about yourself</label>
        <textarea id="hob-about" className="hob-input hob-p-textarea" rows={6} maxLength={500}
          value={draft.about} onChange={(e) => update({ about: e.target.value })}
          placeholder="I am a good listener. I like old songs and evening chai. If you had a hard day, I am happy to talk." />
        <div className="hob-p-row">
          <p className="hob-help">We'll polish your words into your profile. Never add phone numbers, links or social media.</p>
          <span className={`hob-p-count${len < 40 ? ' is-low' : ''}`} aria-live="polite">{len} / 500</span>
        </div>
        {len > 0 && len < 40 && <p className="hob-help">Write at least {40 - len} more characters.</p>}
        {leak && <p className="hob-error" role="alert">{leak}</p>}
      </div>

      <div className="hob-p-examples">
        <p className="hob-label">Tap to add an idea</p>
        {EXAMPLES.map((t) => (
          <button key={t} type="button" className="hob-p-example" onClick={() => addExample(t)}>+ {t}</button>
        ))}
      </div>
    </div>
  );
}
