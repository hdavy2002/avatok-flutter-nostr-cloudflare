import { useEffect } from 'react';
import { LANGUAGES, STYLES } from '../data';
import type { StepProps } from '../types';

const STYLE_DESC: Record<string, string> = {
  'Steady & encouraging': 'You help people feel they can do it.',
  'Cheerful & chatty': 'You bring energy and love a long talk.',
  'Calm listener': 'You listen well and speak softly.',
  'Funny & light': 'You make people smile, even on a bad day.',
  'Straight-talking': 'You are honest and give clear advice.',
  'Gentle & patient': 'You take your time and never rush anyone.',
};

export default function LanguagesStep({ draft, update, setAction }: StepProps) {
  const ok = draft.languages.length >= 1 && !!draft.style;
  useEffect(() => {
    setAction({ label: 'Continue', disabled: !ok, run: () => true });
  }, [ok]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (l: string) =>
    update({ languages: draft.languages.includes(l) ? draft.languages.filter((x) => x !== l) : [...draft.languages, l] });

  return (
    <div className="hob-p-step">
      <h1 className="hob-h1">Languages & style</h1>
      <p className="hob-lead">Callers want to talk in a language they feel at home in.</p>

      <fieldset className="hob-p-fieldset">
        <legend className="hob-label">Languages you speak (pick at least one)</legend>
        <div className="hob-p-chips">
          {LANGUAGES.map((l) => (
            <button key={l} type="button" className="hob-chip" aria-pressed={draft.languages.includes(l)} onClick={() => toggle(l)}>{l}</button>
          ))}
        </div>
      </fieldset>

      <fieldset className="hob-p-fieldset">
        <legend className="hob-label">Your conversation style</legend>
        <div className="hob-p-style-grid">
          {STYLES.map((s) => (
            <button key={s} type="button" className="hob-p-style" aria-pressed={draft.style === s} onClick={() => update({ style: s })}>
              <strong>{s}</strong>
              <span>{STYLE_DESC[s] ?? ''}</span>
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
