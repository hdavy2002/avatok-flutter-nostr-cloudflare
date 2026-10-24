/* [HF-CREATOR-BADGES-1] "How will fans trust you?" Two badges that can BOTH be picked (at least one):
 * a connected YouTube / Instagram channel, and video KYC (Aadhaar + 10-second selfie). The other one can be added later
 * from the dashboard ("My verifications"). Nothing is sent to the worker here; each badge is created by its own step. */
import { useEffect, useState } from 'react';
import { capture } from '../../../lib/analytics';
import Icon, { type IconName } from '../Icon';
import type { StepProps } from '../types';

type Pick = 'channel' | 'kyc';
const TILES: { key: Pick; icon: IconName; title: string; sub: string; note: string }[] = [
  { key: 'channel', icon: 'video', title: 'Connect my YouTube / Instagram', sub: 'Show your channel to your fans. We check it automatically. No ID check needed.', note: 'Needs 20 followers and 1,000 YouTube views.' },
  { key: 'kyc', icon: 'id', title: 'Video KYC (Aadhaar + 10-second selfie)', sub: 'No channel needed. Perfect if you simply like to chat, keep company or share your day. Our team checks it is really you.', note: 'Callers see a "Video KYC verified" badge.' },
];

export default function TrustStep({ draft, update, setAction }: StepProps) {
  const [picks, setPicks] = useState<Record<Pick, boolean>>({ channel: draft.wantChannel, kyc: draft.wantKyc });
  const any = picks.channel || picks.kyc;

  useEffect(() => {
    setAction({
      label: 'Continue',
      disabled: !any,
      run: () => {
        update({ wantChannel: picks.channel, wantKyc: picks.kyc });
        try { capture('hf_trust_chosen', { channel: picks.channel, video_kyc: picks.kyc } as never); } catch { /* telemetry must never break the flow */ }
        return true;
      },
    });
  }, [picks, any, update, setAction]);

  const toggle = (k: Pick) => setPicks(p => ({ ...p, [k]: !p[k] }));

  return (
    <div>
      <h1 className="hob-h1">How will fans trust you?</h1>
      <p className="hob-lead">Pick one or both. You can add the other one later from your dashboard.</p>
      <div className="hob-s-tiles hob-b-tiles" role="group" aria-label="How will fans trust you?">
        {TILES.map(t => (
          <button key={t.key} type="button" role="checkbox" aria-checked={picks[t.key]} className="hob-s-tile" onClick={() => toggle(t.key)}>
            <span className="hob-s-ico" aria-hidden="true"><Icon name={t.icon} size={32} /></span>
            <span className="hob-s-txt">
              <span className="hob-s-title">{t.title}</span>
              <span className="hob-s-sub">{t.sub}</span>
              <span className="hob-s-note">{t.note}</span>
            </span>
            <span className="hob-s-tick" aria-hidden="true">{picks[t.key] && <Icon name="check" size={22} />}</span>
          </button>
        ))}
      </div>
      {!any && <p className="hob-help" role="status">Please pick at least one.</p>}
      <p className="hob-help">You can add the other one later from your dashboard.</p>
    </div>
  );
}
