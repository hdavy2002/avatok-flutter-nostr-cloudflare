/* [HF-CREATOR-BADGES-1] "Join a special space?" Only shown to creators who chose video KYC. None / Women-only / LGBTQ+, one at a time.
 * Women-only needs an Aadhaar that shows Female. POST /api/hf/spaces/space. */
import { useEffect, useState } from 'react';
import { capture } from '../../../lib/analytics';
import Icon, { type IconName } from '../Icon';
import DeclareFields, { declareReady, type DeclareValue } from './DeclareStep';
import type { SpaceKind, StepProps } from '../types';

const OPTIONS: { key: SpaceKind | null; icon: IconName; title: string; sub: string; note?: string }[] = [
  { key: null, icon: 'user', title: 'No special space', sub: 'Chat with everyone who is allowed to call you.' },
  { key: 'women', icon: 'heart', title: 'Women-only', sub: 'Only verified women can call you. Your Aadhaar must show Female.' },
  { key: 'lgbtq', icon: 'sparkle', title: 'LGBTQ+', sub: 'A friendly space for LGBTQ+ callers.', note: 'The "LGBTQ+ channel" tag is shown publicly on your profile.' },
];

export default function SpaceStep({ draft, update, api, setAction }: StepProps) {
  const [pick, setPick] = useState<SpaceKind | null>(draft.space);
  const [dv, setDv] = useState<DeclareValue>({ declare: false, terms: false, publicTag: false });
  const [error, setError] = useState('');
  const skipDeclare = draft.kycGender === 'transgender';
  const womenBlocked = draft.kycGender !== null && draft.kycGender !== 'woman';
  const alreadyLgbtq = pick === 'lgbtq' && draft.space === 'lgbtq' && draft.lgbtqDeclared;
  const ready = pick !== 'lgbtq' || alreadyLgbtq || declareReady(dv, skipDeclare);

  useEffect(() => {
    setAction({
      label: 'Continue',
      disabled: !ready || (pick === 'women' && womenBlocked),
      run: async () => {
        setError('');
        if (pick === draft.space && !(pick === 'lgbtq' && !draft.lgbtqDeclared)) return true; // nothing changed
        const body = pick === 'lgbtq'
          ? (skipDeclare ? { space: pick, publicTagConsent: true as const } : { space: pick, declare: true as const, acceptTerms: true as const, publicTagConsent: true as const })
          : { space: pick };
        const r = await api.setSpace(body);
        if (!r.ok) { setError(r.error || 'We could not save this. Please try again.'); return false; }
        try { capture(pick ? 'hf_space_joined' : 'hf_space_left', pick ? ({ space: pick } as never) : ({} as never)); } catch { /* ignore */ }
        update(pick
          ? { space: pick, callerLevel: 'video_kyc', callerLocked: true, lgbtqDeclared: pick === 'lgbtq' }
          : { space: null, callerLocked: false, lgbtqDeclared: false });
        return true;
      },
    });
  }, [pick, ready, womenBlocked, skipDeclare, draft.space, draft.lgbtqDeclared, api, update, setAction]);

  return (
    <div>
      <h1 className="hob-h1">Join a special space?</h1>
      <p className="hob-lead">Totally optional. You can pick one space at a time and change it later from your dashboard.</p>
      <div className="hob-s-tiles hob-b-tiles hob-b-tiles3" role="radiogroup" aria-label="Join a special space?">
        {OPTIONS.map(o => {
          const blocked = o.key === 'women' && womenBlocked;
          return (
            <button key={String(o.key)} type="button" role="radio" aria-checked={pick === o.key} disabled={blocked} className="hob-s-tile" onClick={() => { setPick(o.key); setError(''); }}>
              <span className="hob-s-ico" aria-hidden="true"><Icon name={o.icon} size={32} /></span>
              <span className="hob-s-txt">
                <span className="hob-s-title">{o.title}</span>
                <span className="hob-s-sub">{o.sub}</span>
                {blocked && <span className="hob-s-note">Your Aadhaar does not show Female, so this space is not open to you.</span>}
                {!blocked && o.note && <span className="hob-s-note">{o.note}</span>}
              </span>
              <span className="hob-s-tick" aria-hidden="true">{pick === o.key && <Icon name="check" size={22} />}</span>
            </button>
          );
        })}
      </div>
      {pick === 'lgbtq' && !alreadyLgbtq && <DeclareFields value={dv} onChange={setDv} skipDeclare={skipDeclare} />}
      {pick && <p className="hob-help">Space creators are called only by customers with full video KYC.</p>}
      <p className="hob-error" role="alert" aria-live="polite">{error}</p>
    </div>
  );
}
