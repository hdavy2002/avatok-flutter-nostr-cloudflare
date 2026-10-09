import { useEffect } from 'react';
import { PRICE_MIN, PRICE_MAX, hostShare, rupees } from '../data';
import type { StepProps } from '../types';

const SUGGESTED = [10, 15, 20, 25, 30];

export default function PriceStep({ draft, update, setAction }: StepProps) {
  const price = draft.pricePerMin;
  const mine = hostShare(price);
  const platform = Math.round((price - mine) * 100) / 100;
  const monthly = Math.round(mine * 60 * 25);
  const set = (v: number) => update({ pricePerMin: Math.min(PRICE_MAX, Math.max(PRICE_MIN, Math.round(v))) });

  useEffect(() => {
    setAction({ label: 'Continue', run: () => true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="hob-p-step">
      <h1 className="hob-h1">Your price</h1>
      <p className="hob-lead">One price for every topic, charged per minute of call.</p>

      <div className="hob-card hob-p-price-card">
        <div className="hob-p-price-big" aria-live="polite">{rupees(price)} <small>/ min</small></div>
        <div className="hob-p-stepper">
          <button type="button" className="hob-p-round" aria-label="Lower price by 1 rupee" disabled={price <= PRICE_MIN} onClick={() => set(price - 1)}>−</button>
          <input type="range" className="hob-p-range" min={PRICE_MIN} max={PRICE_MAX} step={1} value={price}
            aria-label="Price per minute in rupees" onChange={(e) => set(Number(e.target.value))} />
          <button type="button" className="hob-p-round" aria-label="Raise price by 1 rupee" disabled={price >= PRICE_MAX} onClick={() => set(price + 1)}>+</button>
        </div>
        <div className="hob-p-range-ends"><span>{rupees(PRICE_MIN)}</span><span>{rupees(PRICE_MAX)}</span></div>

        <fieldset className="hob-p-fieldset">
          <legend className="hob-label">Quick picks</legend>
          <div className="hob-p-chips">
            {SUGGESTED.map((v) => (
              <button key={v} type="button" className="hob-chip" aria-pressed={price === v} onClick={() => set(v)}>{rupees(v)}</button>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="hob-card hob-p-breakdown">
        <div className="hob-p-line"><span>Caller pays</span><strong>{rupees(price)}/min</strong></div>
        <div className="hob-p-line is-you"><span>You get</span><strong>{rupees(mine)}/min</strong></div>
        <div className="hob-p-line"><span>Platform (incl. GST)</span><strong>{rupees(platform)}</strong></div>
        <p className="hob-p-example-line">1 hour of calls a day for 25 days ≈ <strong>₹{monthly.toLocaleString('en-IN')}</strong> for you</p>
      </div>

      <p className="hob-help">You can change your price any time. <a href="/hosts/rates">How rates work</a></p>
    </div>
  );
}
