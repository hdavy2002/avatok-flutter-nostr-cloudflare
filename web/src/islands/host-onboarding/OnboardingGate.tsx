/* [HF-INTRO-B1] Decides what /hosts/onboarding shows. hfIntroOnboardingEnabled on = the "Download our app" panel (onboarding is app-only, HF-INTRO-22);
 * off or a failed config call = the unchanged step flow.
 * [HF-VERIFY-WEB-FLOW] With the flag on, ?step= / ?add= deep links no longer open the old wizard either:
 *   - someone who is already an influencer (GET /api/hosts/me has a host) sees AlreadyHostPanel -> /dashboard/verifications (+ the app);
 *     [HF-PAYOUT-CARD] ?step=payout sends her to the "Payout details" card (PAYOUT_DETAILS_PATH) instead of the old wizard step;
 *   - [HF-PAYOUT-CARD] ?step=aadhaar (the app's creator space check opens it for the DigiLocker fallback, space_verify.dart) goes to the
 *     standalone ID check /verify/id (same Aadhaar OTP + DigiLocker, role host for an influencer), for anyone;
 *   - everyone else sees the Download our app panel;
 *   - ?dl= (a DigiLocker return already in flight) and ?mock=1 still open the flow so nothing started is lost. */
import { lazy, Suspense, useEffect, useState } from 'react';
import { introAppOnlyEnabled } from '../../lib/introAppOnly';
import { hfCall } from '../../lib/hfCallsApi';
import DownloadAppPanel, { AlreadyHostPanel } from './DownloadAppPanel';

/** [HF-PAYOUT-CARD] Where an influencer adds or changes her UPI ID now (dashboard Earnings, "Payout details" card). */
export const PAYOUT_DETAILS_PATH = '/dashboard/host/earnings#payout-details';

const HostOnboarding = lazy(() => import('./HostOnboarding'));

function inFlight(search: string): boolean {
  try { const q = new URLSearchParams(search); return q.has('dl') || q.get('mock') === '1'; } catch { return false; }
}
function isAadhaarLink(search: string): boolean {
  try { return new URLSearchParams(search).get('step') === 'aadhaar'; } catch { return false; }
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
      if (isAadhaarLink(search)) { window.location.replace('/verify/id?next=%2Fdashboard%2Fverifications'); return; }
      const r = await hfCall<{ host?: unknown }>('GET', '/api/hosts/me').catch(() => null);
      const isHost = !!(r && r.ok && r.data?.host);
      if (!live) return;
      if (isHost && isPayoutLink(search)) { window.location.replace(PAYOUT_DETAILS_PATH); return; } // stays on the loading state while it navigates
      setMode(isHost ? 'host' : 'panel');
    });
    return () => { live = false; };
  }, []);
  if (mode === 'wait') return <div className="hia-wait" role="status" aria-label="Loading" />;
  if (mode === 'panel') return <DownloadAppPanel />;
  if (mode === 'host') return <AlreadyHostPanel />;
  return <Suspense fallback={<div className="hia-wait" role="status" aria-label="Loading" />}><HostOnboarding /></Suspense>;
}
