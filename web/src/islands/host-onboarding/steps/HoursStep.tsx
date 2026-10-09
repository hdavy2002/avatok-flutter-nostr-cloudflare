import { useEffect } from 'react';
import { DAYS } from '../data';
import type { StepProps } from '../types';

export default function HoursStep({ draft, update, setAction }: StepProps) {
  useEffect(() => {
    setAction({ label: 'Continue', run: () => true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const { days, from, to } = draft.hours;
  const setHours = (patch: Partial<typeof draft.hours>) => update({ hours: { ...draft.hours, ...patch } });
  const toggleDay = (d: string) => setHours({ days: days.includes(d) ? days.filter((x) => x !== d) : [...days, d] });

  return (
    <div className="hob-p-step">
      <h1 className="hob-h1">When are you usually free?</h1>
      <p className="hob-lead">This is optional. It only helps callers know when to find you. You can still go online any time.</p>

      <fieldset className="hob-p-fieldset">
        <legend className="hob-label">Days</legend>
        <div className="hob-p-chips">
          {DAYS.map((d) => (
            <button key={d} type="button" className="hob-chip" aria-pressed={days.includes(d)} onClick={() => toggleDay(d)}>{d}</button>
          ))}
        </div>
      </fieldset>

      <div className="hob-grid-2">
        <div className="hob-field">
          <label className="hob-label" htmlFor="hob-from">From</label>
          <input id="hob-from" className="hob-input" type="time" value={from} onChange={(e) => setHours({ from: e.target.value })} />
        </div>
        <div className="hob-field">
          <label className="hob-label" htmlFor="hob-to">To</label>
          <input id="hob-to" className="hob-input" type="time" value={to} onChange={(e) => setHours({ to: e.target.value })} />
        </div>
      </div>

      <h2 className="hob-p-h2">Your comfort</h2>
      <label className="hob-card hob-p-check-card">
        <input type="checkbox" checked={draft.healthConsent} onChange={(e) => update({ healthConsent: e.target.checked })} />
        <span>I am comfortable talking about health topics (e.g. women's health) when a caller asks</span>
      </label>

      {draft.kycGender === 'woman' && (
        <label className="hob-card hob-p-check-card">
          <input type="checkbox" role="switch" checked={draft.womenOnlyLane} onChange={(e) => update({ womenOnlyLane: e.target.checked })} />
          <span>Also join the women-only lane — only verified women can call you there.</span>
        </label>
      )}
    </div>
  );
}
