// [AUMFE-GUIDES-FRONT-1] Explore "Talk to a guide" section (id="guides") — owner-approved mockup MarketVoice.
//
// NOTE FOR AI:
//  - ADMIN-PREVIEW ONLY: renders NOTHING unless usePreview().guides === true (empty mount, no layout shift).
//  - Mounted with client:idle (owner speed rule; idle rather than visible so the #guides anchor target exists soon after load).
//  - Wallet chip: GET /api/wallet/balance (spendable ?? balance; tokens = rupees). "Add money" is disabled until
//    the gateway is approved. Cards: GET /api/voice/agents; subjects the API does not return yet show "Coming soon".
import { useEffect, useRef, useState } from 'react';
import PreviewRibbon from '../../components/PreviewRibbon';
import { captureException } from '../../lib/analytics';
import { usePreview } from '../../lib/preview';
import { loadBalance, rupees, soonFor } from './api';
import { clicked, useGuides, useSeen } from './useGuides';
import './guides.css';

export default function ExploreGuides() {
  const { guides, preview } = usePreview();
  const data = useGuides(guides);
  const [balance, setBalance] = useState<number | null>(null);
  const ref = useRef<HTMLElement>(null);
  useSeen(ref, 'explore', guides);

  useEffect(() => {
    if (!guides) return;
    let alive = true;
    loadBalance().then((b) => { if (alive) setBalance(b); }).catch((e) => captureException(e, { where: 'guides_wallet' }));
    return () => { alive = false; };
  }, [guides]);

  // The section only exists after the preview check, so honour /marketplace#guides ourselves once it is on the page.
  useEffect(() => {
    if (guides && window.location.hash === '#guides') ref.current?.scrollIntoView({ block: 'start' });
  }, [guides]);

  if (!guides) return null;
  const agents = data?.agents ?? [];
  const soon = soonFor(agents);
  const defaultPrice = data?.price ?? null;
  const priceText = (p: number | null) => (p != null ? `${rupees(p)}/min` : 'Per minute');

  return (
    <section ref={ref} id="guides" className="gd-explore" aria-labelledby="gd-x-title">
      <div className="gd-inner">
        <div className="gd-x-head">
          <div>
            <div className="gd-x-title">
              <h2 id="gd-x-title">Talk to a guide</h2>
              <PreviewRibbon force={preview} />
            </div>
            <p className="gd-x-sub">Voice calls with AI guides. Paid by the minute from your wallet.</p>
          </div>
          {balance != null && (
            <div className="gd-wallet">
              Wallet: {rupees(balance)}
              <button type="button" className="gd-add" disabled aria-disabled="true" title="Coming soon">Add money</button>
            </div>
          )}
        </div>
        <div className="gd-x-grid">
          {agents.map((a) => (
            <div className="gd-gcard" key={a.id}>
              <div className="gd-gtop">
                <div className="gd-gav" style={{ background: a.tint }} aria-hidden="true">{a.initial}</div>
                <div><div className="gd-gname">{a.name}</div><div className="gd-gsub">{a.subject} · AI guide</div></div>
              </div>
              <div className="gd-gblurb">{a.blurb}</div>
              <div className="gd-gfoot">
                <span className="gd-gprice">{priceText(a.price)}</span>
                <a className="gd-call" href={'/talk?guide=' + encodeURIComponent(a.id)} onClick={() => clicked('explore', 'call_' + a.id)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
                  Call
                </a>
              </div>
            </div>
          ))}
          {soon.map((s) => (
            <div className="gd-gcard" key={s.subject}>
              <div className="gd-gtop">
                <div className="gd-gav" style={{ background: s.tint }} aria-hidden="true">{s.initial}</div>
                <div><div className="gd-gname">{s.name}</div><div className="gd-gsub">{s.subject} · AI guide</div></div>
              </div>
              <div className="gd-gblurb">{s.blurb}</div>
              <div className="gd-gfoot">
                <span className="gd-gprice">{priceText(defaultPrice)}</span>
                <span className="gd-soon-pill">Coming soon</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
