/* [HF-CREATOR-SPACES-1] LGBTQ+ channel: private self-declaration (skipped when the Aadhaar gender is Transgender), terms,
 * and the separate consent that the "LGBTQ+ channel" tag is PUBLIC. The declaration is sent to the worker and never
 * kept in the draft, storage or analytics. */
import { useEffect, useState } from 'react';
import { capture } from '../../../lib/analytics';
import type { StepProps } from '../types';

export default function DeclareStep({ draft, update, api, setAction }: StepProps) {
  const skipDeclare = draft.kycGender === 'transgender';
  const [declare, setDeclare] = useState(false);
  const [terms, setTerms] = useState(false);
  const [publicTag, setPublicTag] = useState(false);
  const [error, setError] = useState('');
  const done = draft.lgbtqDeclared;
  const ready = publicTag && (skipDeclare || (declare && terms));

  useEffect(() => {
    if (done) { setAction({ label: 'Continue', run: () => true }); return; }
    setAction({
      label: 'Continue',
      disabled: !ready,
      run: async () => {
        setError('');
        const body = skipDeclare
          ? { kind: 'lgbtq' as const, publicTagConsent: true as const }
          : { kind: 'lgbtq' as const, declare: true as const, acceptTerms: true as const, publicTagConsent: true as const };
        const r = await api.setCreator(body);
        if (!r.ok) { setError(r.error || 'We could not save this. Please try again.'); return false; }
        try { capture('hf_space_creator_chosen', { kind: 'lgbtq', step: 'declare' } as never); } catch { /* ignore */ }
        update({ lgbtqDeclared: true });
        return true;
      },
    });
  }, [done, ready, skipDeclare, api, update, setAction]);

  if (done) {
    return (
      <div>
        <h1 className="hob-h1">Your LGBTQ+ channel is set up</h1>
        <p className="hob-lead">Thank you. Next is a short selfie video so our team can check it is really you.</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="hob-h1">About your LGBTQ+ channel</h1>
      <p className="hob-lead">{skipDeclare ? 'Your Aadhaar already shows what we need, so there is nothing private to declare. We only need your say-so on the public tag.' : 'Two quick tick-boxes. What you declare here stays private and is never shown to anyone.'}</p>
      {!skipDeclare && (
        <>
          <label className="hob-card hob-f-consent hob-s-check">
            <input type="checkbox" checked={declare} onChange={e => setDeclare(e.target.checked)} />
            <span>I am LGBTQ+. <strong>This is private and never shown.</strong></span>
          </label>
          <label className="hob-card hob-f-consent hob-s-check">
            <input type="checkbox" checked={terms} onChange={e => setTerms(e.target.checked)} />
            <span>I accept the <a href="/lgbtq" target="_blank" rel="noopener">LGBTQ+ space terms</a>.</span>
          </label>
        </>
      )}
      <label className="hob-card hob-f-consent hob-s-check">
        <input type="checkbox" checked={publicTag} onChange={e => setPublicTag(e.target.checked)} />
        <span>I understand my profile will <strong>publicly show "LGBTQ+ channel"</strong>, including in search and on Google.</span>
      </label>
      <p className="hob-error" role="alert" aria-live="polite">{error}</p>
    </div>
  );
}
