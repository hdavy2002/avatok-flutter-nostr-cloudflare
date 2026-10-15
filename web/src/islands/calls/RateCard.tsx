/* [HF-STD-PLAN-1] The Standard plan rate card, shown before a caller commits (wallet page, call confirm step).
 * Emits hf_std_rate_card_viewed once per mount. Tiers come from the worker (plan.tiers / priceTiers); the static fallback matches the contract. */
import { useEffect } from 'react';
import { capture } from '../../lib/analytics';
import { RATE_CARD_NOTE, rateCardLines, type PriceTier } from '../../lib/hfStdPlan';

/** Just the lines, for use inside an existing list (the call sheet's facts list). */
export function RateLines({ tiers }: { tiers?: PriceTier[] | null }) {
  return <>{rateCardLines(tiers).map(l => <span key={l} style={{ display: 'block' }}>{l}</span>)}</>;
}

export default function RateCard({ surface, tiers }: { surface: string; tiers?: PriceTier[] | null }) {
  useEffect(() => { try { capture('hf_std_rate_card_viewed', { surface }); } catch { /* telemetry never blocks */ } }, [surface]);
  return (
    <section className="hfc-card" aria-labelledby="hfw-plan">
      <h2 id="hfw-plan">Standard plan</h2>
      <ul className="hfc-calls">
        {rateCardLines(tiers).map(l => <li key={l}><strong>{l}</strong></li>)}
      </ul>
      <p className="hfc-sub" style={{ margin: 0 }}>{RATE_CARD_NOTE} The same rate for every influencer.</p>
    </section>
  );
}
