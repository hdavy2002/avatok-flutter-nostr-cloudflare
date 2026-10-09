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

      <label className="hob-card hob-p-check-card">
        <input type="checkbox" role="switch" checked={draft.lgbtqLane} onChange={(e) => update({ lgbtqLane: e.target.checked, ...(e.target.checked ? {} : { lgbtqShowOnProfile: false }) })} />
        <span>
          <strong>Join the LGBTQ+ space</strong>
          <span className="hob-p-sub">A private lane where LGBTQ+ callers talk to LGBTQ+ hosts. Only verified callers can reach you there. This choice is private — we never guess, and you can change it any time. <a className="hob-p-link" href="/lgbtq" target="_blank" rel="noopener">Learn more</a></span>
        </span>
      </label>
      {draft.lgbtqLane && (
        <label className="hob-card hob-p-check-card hob-p-check-sub">
          <input type="checkbox" checked={draft.lgbtqShowOnProfile} onChange={(e) => update({ lgbtqShowOnProfile: e.target.checked })} />
          <span>Also show 'LGBTQ+ friendly' on my public profile (optional)</span>
        </label>
      )}

      {draft.kycGender === 'woman' && (
        <label className="hob-card hob-p-check-card">
          <input type="checkbox" role="switch" checked={draft.womenOnlyLane} onChange={(e) => update({ womenOnlyLane: e.target.checked })} />
          <span>Also join the women-only lane — only verified women can call you there.</span>
        </label>
      )}
    </div>
  );
}
