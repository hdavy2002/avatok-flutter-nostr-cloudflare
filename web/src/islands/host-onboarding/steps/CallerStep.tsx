/* [HF-CREATOR-BADGES-1] "Who can call you?" Free for every creator. POST /api/hf/spaces/caller-level.
 * Space creators are locked to video-KYC customers (plus their space rule). */
import { useEffect, useState } from 'react';
import { capture } from '../../../lib/analytics';
import Icon from '../Icon';
import type { CallerLevel, StepProps } from '../types';

const OPTIONS: { key: CallerLevel; title: string; sub: string }[] = [
  { key: 'everyone', title: 'Everyone with a verified phone', sub: 'The widest reach. Every customer who has verified their phone can call you.' },
  { key: 'video_kyc', title: 'Only video-KYC customers', sub: 'Only customers who completed Aadhaar + selfie video KYC can call, book or join your queue.' },
];

export default function CallerStep({ draft, update, api, setAction }: StepProps) {
  const locked = draft.callerLocked || draft.space !== null;
  const [pick, setPick] = useState<CallerLevel>(locked ? 'video_kyc' : draft.callerLevel);
  const [error, setError] = useState('');

  useEffect(() => {
    setAction({
      label: 'Continue',
      run: async () => {
        setError('');
        if (locked) return true;
        if (pick !== draft.callerLevel) {
          const r = await api.setCallerLevel(pick);
          if (!r.ok) { setError(r.error || 'We could not save this. Please try again.'); return false; }
          try { capture('hf_caller_level_set', { level: pick } as never); } catch { /* ignore */ }
          update({ callerLevel: pick });
        }
        return true;
      },
    });
  }, [pick, locked, draft.callerLevel, api, update, setAction]);

  return (
    <div>
      <h1 className="hob-h1">Who can call you?</h1>
      <p className="hob-lead">This is free and you can change it any time from your dashboard.</p>
      <div className="hob-s-tiles hob-b-tiles" role="radiogroup" aria-label="Who can call you?">
        {OPTIONS.map(o => (
          <button key={o.key} type="button" role="radio" aria-checked={pick === o.key} disabled={locked && o.key !== 'video_kyc'} className="hob-s-tile" onClick={() => { setPick(o.key); setError(''); }}>
            <span className="hob-s-ico" aria-hidden="true"><Icon name={o.key === 'everyone' ? 'phone' : 'shield'} size={32} /></span>
            <span className="hob-s-txt">
              <span className="hob-s-title">{o.title}</span>
              <span className="hob-s-sub">{o.sub}</span>
            </span>
            <span className="hob-s-tick" aria-hidden="true">{pick === o.key && <Icon name="check" size={22} />}</span>
          </button>
        ))}
      </div>
      {locked && <p className="hob-card hob-b-lock"><Icon name="lock" size={22} /> Because you are in a special space, only video-KYC customers can call you. This is how the space stays comfortable for everyone.</p>}
      <p className="hob-help hob-b-never"><Icon name="shield" size={20} /> We never share any customer's details with anyone.</p>
      <p className="hob-error" role="alert" aria-live="polite">{error}</p>
    </div>
  );
}
