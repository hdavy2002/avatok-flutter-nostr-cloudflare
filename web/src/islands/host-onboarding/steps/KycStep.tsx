import { useEffect, useState } from 'react';
import Icon from '../Icon';
import type { Gender, StepProps } from '../types';

export default function KycStep({ draft, update, api, setAction }: StepProps) {
  const [choice, setChoice] = useState<Gender | null>(draft.kycGender);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const done = draft.kycDone;

  useEffect(() => {
    if (done) setAction({ label: 'Continue', run: () => true });
    else setAction({
      label: busy ? 'Checking…' : 'Start video KYC',
      disabled: !choice || busy,
      run: async () => {
        if (!choice) return false;
        setError(''); setBusy(true);
        try {
          const r = await api.runVideoKyc(choice);
          if (!r.ok) { setError('Video check did not work. Please try again.'); return false; }
          update({ kycDone: true, kycGender: r.gender });
          return true;
        } catch {
          setError('Video check did not work. Please try again.');
          return false;
        } finally { setBusy(false); }
      },
    });
  }, [done, choice, busy, api, update, setAction]);

  if (done) {
    return (
      <div>
        <h1 className="hob-h1">Video KYC</h1>
        <div className="hob-card hob-v-done">
          <span className="hob-v-badge" aria-hidden="true"><Icon name="check" /></span>
          <p className="hob-v-strong">Verified ✓</p>
        </div>
      </div>
    );
  }

  if (busy) {
    return (
      <div className="hob-v-busy" role="status" aria-live="polite">
        <span className="hob-v-spinner" aria-hidden="true" />
        <h1 className="hob-h1">Checking…</h1>
        <p className="hob-lead">Please wait a moment.</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="hob-h1">A quick video check</h1>
      <p className="hob-lead">This keeps every caller and host safe.</p>
      <ul className="hob-card hob-v-list">
        <li><span className="hob-v-ico" aria-hidden="true"><Icon name="video" /></span><span>Look at the camera</span></li>
        <li><span className="hob-v-ico" aria-hidden="true"><Icon name="id" /></span><span>Hold your Aadhaar or ID card</span></li>
        <li><span className="hob-v-ico" aria-hidden="true"><Icon name="clock" /></span><span>It takes about 2 minutes. Our verification partner does the check.</span></li>
      </ul>

      <div className="hob-v-preview" role="group" aria-labelledby="hob-v-prev">
        <p className="hob-v-tag">Preview only</p>
        <p id="hob-v-prev">For this preview, choose what KYC would show:</p>
        <div className="hob-v-chips">
          {(['woman', 'man'] as Gender[]).map((g) => (
            <button key={g} type="button" className="hob-chip" aria-pressed={choice === g} onClick={() => setChoice(g)}>
              {g === 'woman' ? 'Woman' : 'Man'}
            </button>
          ))}
        </div>
      </div>
      <p className="hob-error" role="alert" aria-live="polite">{error}</p>
    </div>
  );
}
