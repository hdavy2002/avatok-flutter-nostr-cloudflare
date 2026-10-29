/* [HF-INTRO-B1] Decides what /hosts/onboarding shows. hfIntroOnboardingEnabled on = the "Download our app" panel (onboarding is app-only, HF-INTRO-22);
 * off or a failed config call = the unchanged step flow.
 * [HF-VERIFY-WEB-FLOW] With the flag on, ?step= / ?add= deep links no longer open the old wizard either:
 *   - someone who is already an influencer (GET /api/hosts/me has a host) sees AlreadyHostPanel -> /dashboard/verifications (+ the app);
 *     only ?step=payout still opens its step for her, because withdrawals need a UPI ID and the site has no other place to add it;
 *   - everyone else sees the Download our app panel;
 *   - ?dl= (a DigiLocker return already in flight) and ?mock=1 still open the flow so nothing started is lost. */
import { lazy, Suspense, useEffect, useState } from 'react';
import { introAppOnlyEnabled } from '../../lib/introAppOnly';
import { hfCall } from '../../lib/hfCallsApi';
import DownloadAppPanel, { AlreadyHostPanel } from './DownloadAppPanel';

const HostOnboarding = lazy(() => import('./HostOnboarding'));

function inFlight(search: string): boolean {
  try { const q = new URLSearchParams(search); return q.has('dl') || q.get('mock') === '1'; } catch { return false; }
}
function isPayoutLink(search: string): boolean {
  try { return new URLSearchParams(search).get('step') === 'payout'; } catch { return false; }
}

export default function OnboardingGate() {
  const [mode, setMode] = useState<'wait' | 'panel' | 'host' | 'flow'>('wait');
  useEffect(() => {
    let live = true;
    const search = window.location.search;
    if (inFlight(search)) { setMode('flow'); return; }
    void introAppOnlyEnabled().then(async (on) => {
      if (!on) { if (live) setMode('flow'); return; }
      const r = await hfCall<{ host?: unknown }>('GET', '/api/hosts/me').catch(() => null);
      const isHost = !!(r && r.ok && r.data?.host);
      if (!live) return;
      setMode(isHost ? (isPayoutLink(search) ? 'flow' : 'host') : 'panel');
    });
    return () => { live = false; };
  }, []);
  if (mode === 'wait') return <div className="hia-wait" role="status" aria-label="Loading" />;
  if (mode === 'panel') return <DownloadAppPanel />;
  if (mode === 'host') return <AlreadyHostPanel />;
  return <Suspense fallback={<div className="hia-wait" role="status" aria-label="Loading" />}><HostOnboarding /></Suspense>;
}
