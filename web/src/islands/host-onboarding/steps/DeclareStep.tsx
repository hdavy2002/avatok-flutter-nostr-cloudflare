/* [HF-CREATOR-BADGES-1] LGBTQ+ space details, now a block inside the space step (no separate step any more).
 * Private self-declaration (skipped when the Aadhaar gender is Transgender), terms, and the separate consent that the
 * "LGBTQ+ channel" tag is PUBLIC. The declaration goes to the worker and is never kept in the draft, storage or analytics. */
import { useEffect } from 'react';

export interface DeclareValue { declare: boolean; terms: boolean; publicTag: boolean }
export const declareReady = (v: DeclareValue, skipDeclare: boolean) => v.publicTag && (skipDeclare || (v.declare && v.terms));

export default function DeclareFields({ value, onChange, skipDeclare }: { value: DeclareValue; onChange: (v: DeclareValue) => void; skipDeclare: boolean }) {
  useEffect(() => { /* controlled component */ }, []);
  return (
    <div className="hob-b-declare">
      <p className="hob-lead">{skipDeclare ? 'Your Aadhaar already shows what we need, so there is nothing private to declare. We only need your say-so on the public tag.' : 'Two quick tick-boxes. What you declare here stays private and is never shown to anyone.'}</p>
      {!skipDeclare && (
        <>
          <label className="hob-card hob-f-consent hob-s-check">
            <input type="checkbox" checked={value.declare} onChange={e => onChange({ ...value, declare: e.target.checked })} />
            <span>I am LGBTQ+. <strong>This is private and never shown.</strong></span>
          </label>
          <label className="hob-card hob-f-consent hob-s-check">
            <input type="checkbox" checked={value.terms} onChange={e => onChange({ ...value, terms: e.target.checked })} />
            <span>I accept the <a href="/lgbtq" target="_blank" rel="noopener">LGBTQ+ space terms</a>.</span>
          </label>
        </>
      )}
      <label className="hob-card hob-f-consent hob-s-check">
        <input type="checkbox" checked={value.publicTag} onChange={e => onChange({ ...value, publicTag: e.target.checked })} />
        <span>I understand my profile will <strong>publicly show "LGBTQ+ channel"</strong>, including in search and on Google.</span>
      </label>
    </div>
  );
}
