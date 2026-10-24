/* [HF-CREATOR-SPACES-1] The locked state shown instead of Call / Book / Join queue / Notify on a space channel the viewer may not call yet. */
import { useEffect } from 'react';
import { LOCK_TEXT, trackGate, verifyHref, signInUrl, type Space } from '../../lib/hfSpaces';
import '../../styles/hf-spaces.css';

export default function SpaceLock({ lane, signedOut, missing, wait }: { lane: Space; signedOut?: boolean; missing?: string; wait?: boolean }) {
  useEffect(() => { if (!wait) trackGate(lane, signedOut ? 'signin' : missing || 'unknown'); }, [lane, signedOut, missing, wait]);
  if (wait) return <div className="hf-space-lock is-wait" role="status"><p>Checking your access…</p></div>;
  const verify = verifyHref(lane);
  const href = signedOut ? signInUrl(verify) : verify;
  return (
    <div className="hf-space-lock" role="status">
      <p>{LOCK_TEXT[lane]}</p>
      <a className="hf-space-lock-btn" href={href}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
        {signedOut ? 'Sign in to verify' : 'Verify to call'}
      </a>
    </div>
  );
}
