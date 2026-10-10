/* [HF-APP-3] Replaces the "Add money" card on /wallet (spec HF-APP-D8, HF-TOK-D7).
 * Plain web: money is added in the app only (Google Play), so a "Get the app" panel.
 * App mode: an "Add money" button that says "Coming soon" until Play Billing is built (HF-TOK-PLAY-1).
 * The old gateway top-up (TopupPanel.tsx, flags hfTopupEnabled) is untouched but no longer mounted here. */
import { useState } from 'react';
import { BRAND } from '../../lib/brand';
import { isAppMode } from '../../lib/nativeBridge';
import { HF_PLAY_URL, trackWebBlocked } from '../../lib/hfApp';

export default function TokensPanel() {
  const [soon, setSoon] = useState(false);

  if (isAppMode()) {
    return (
      <section className="hfc-card" aria-labelledby="hft-h">
        <h2 id="hft-h">Add money</h2>
        <button type="button" className="hfc-btn hfc-primary" onClick={() => setSoon(true)}>Add money</button>
        {soon && <p role="status" className="hfc-note" style={{ margin: 0 }}>Coming soon</p>}
      </section>
    );
  }

  return (
    <section className="hfc-card" aria-labelledby="hft-h">
      <h2 id="hft-h">Add money in the app</h2>
      <p className="hfc-sub" style={{ margin: 0 }}>You add money to your wallet through Google Play in the {BRAND.name} Android app.</p>
      <a className="hfc-btn hfc-primary" href={HF_PLAY_URL} target="_blank" rel="noopener noreferrer" onClick={() => trackWebBlocked('topup')}>Get the app</a>
    </section>
  );
}
