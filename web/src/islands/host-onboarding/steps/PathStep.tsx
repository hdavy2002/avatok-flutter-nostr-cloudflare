/* [HF-CREATOR-SPACES-1] First real choice: a channel creator (YouTube / Instagram) or a Women-only / LGBTQ+ channel creator. */
import { useEffect, useState } from 'react';
import { capture } from '../../../lib/analytics';
import Icon, { type IconName } from '../Icon';
import type { CreatorPath, StepProps } from '../types';

const TILES: { kind: CreatorPath; icon: IconName; title: string; sub: string; note?: string }[] = [
  { kind: 'channel', icon: 'video', title: 'I have a YouTube / Instagram channel', sub: 'Connect your channel and let your fans call you. No ID check needed.' },
  { kind: 'women', icon: 'heart', title: 'Start a Women-only channel', sub: 'No channel needed. Only verified women can call you. We check your Aadhaar and a short selfie video.' },
  { kind: 'lgbtq', icon: 'sparkle', title: 'Start an LGBTQ+ channel', sub: 'No channel needed. We check your Aadhaar and a short selfie video.', note: 'The "LGBTQ+ channel" tag is shown publicly on your profile.' },
];

export default function PathStep({ draft, update, api, setAction }: StepProps) {
  const [pick, setPick] = useState<CreatorPath | null>(draft.path);
  const [error, setError] = useState('');

  useEffect(() => {
    setAction({
      label: 'Continue',
      disabled: !pick,
      run: async () => {
        if (!pick) return false;
        setError('');
        // LGBTQ+ needs the declaration + public-tag consent first, so that POST happens on the next steps.
        if (pick !== 'lgbtq') {
          const r = await api.setCreator({ kind: pick });
          if (!r.ok) { setError(r.error || 'We could not save your choice. Please try again.'); return false; }
        }
        try { capture('hf_space_creator_chosen', { kind: pick } as never); } catch { /* telemetry must never break the flow */ }
        update({ path: pick });
        return true;
      },
    });
  }, [pick, api, update, setAction]);

  return (
    <div>
      <h1 className="hob-h1">How do you want to start?</h1>
      <p className="hob-lead">Pick the one that fits you. You can change your mind before you finish.</p>
      <div className="hob-s-tiles" role="radiogroup" aria-label="How do you want to start?">
        {TILES.map(t => (
          <button key={t.kind} type="button" role="radio" aria-checked={pick === t.kind} className="hob-s-tile" onClick={() => { setPick(t.kind); setError(''); }}>
            <span className="hob-s-ico" aria-hidden="true"><Icon name={t.icon} size={32} /></span>
            <span className="hob-s-txt">
              <span className="hob-s-title">{t.title}</span>
              <span className="hob-s-sub">{t.sub}</span>
              {t.note && <span className="hob-s-note">{t.note}</span>}
            </span>
            <span className="hob-s-tick" aria-hidden="true">{pick === t.kind && <Icon name="check" size={22} />}</span>
          </button>
        ))}
      </div>
      <p className="hob-error" role="alert" aria-live="polite">{error}</p>
    </div>
  );
}
