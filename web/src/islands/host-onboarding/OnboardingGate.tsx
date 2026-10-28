/* [HF-INTRO-B1] Decides what /hosts/onboarding shows. hfIntroOnboardingEnabled on = the "Download our app" panel (onboarding is app-only, HF-INTRO-22);
 * off, a failed config call, or an existing influencer's maintenance link (?step= / ?add= / ?dl= / ?mock=1) = the unchanged step flow. */
import { lazy, Suspense, useEffect, useState } from 'react';
import { introAppOnlyEnabled, isMaintenanceLink } from '../../lib/introAppOnly';
import DownloadAppPanel from './DownloadAppPanel';

const HostOnboarding = lazy(() => import('./HostOnboarding'));

export default function OnboardingGate() {
  const [mode, setMode] = useState<'wait' | 'panel' | 'flow'>('wait');
  useEffect(() => {
    let live = true;
    if (isMaintenanceLink(window.location.search)) { setMode('flow'); return; }
    void introAppOnlyEnabled().then((on) => { if (live) setMode(on ? 'panel' : 'flow'); });
    return () => { live = false; };
  }, []);
  if (mode === 'wait') return <div className="hia-wait" role="status" aria-label="Loading" />;
  if (mode === 'panel') return <DownloadAppPanel />;
  return <Suspense fallback={<div className="hia-wait" role="status" aria-label="Loading" />}><HostOnboarding /></Suspense>;
}
