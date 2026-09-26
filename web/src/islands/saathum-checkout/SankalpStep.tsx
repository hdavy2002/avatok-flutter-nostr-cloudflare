/* [SAATHUM-CHECKOUT-UI 2026-09-26] Step 2 — Sankalp (name, gotra, family
 * names, wish). Prefilled from the profile (islands/saathum-checkout/profile.ts);
 * the worker saves it back to the profile on POST /checkout, per the spec.
 *
 * [SAATHUM-EVENT-TYPES 2026-09-27] For a non-ritual event (satsang, sermon,
 * meditation) this same component renders as the "Details" step — just the
 * name, prefilled, nothing else — rather than a separate step/component,
 * since it produces the same Sankalp shape the checkout body needs either
 * way (gotra/family/wish simply stay undefined).
 */
import { useEffect, useState } from 'react';
import { capture } from '../../lib/analytics';
import type { Sankalp } from './types';
import type { EventType } from '../../lib/eventTypes';

export function SankalpStep({
  value,
  onBack,
  onContinue,
  listingId,
  ritual,
  eventType,
  stepIndex,
  totalSteps,
}: {
  value: Sankalp;
  onBack: () => void;
  onContinue: (s: Sankalp) => void;
  listingId: string;
  ritual: boolean;
  eventType: EventType;
  stepIndex: number;
  totalSteps: number;
}) {
  const [name, setName] = useState(value.name);
  const [gotra, setGotra] = useState(value.gotra ?? '');
  const [family, setFamily] = useState<string[]>(value.family ?? []);
  const [familyInput, setFamilyInput] = useState('');
  const [wish, setWish] = useState(value.wish ?? '');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    capture('saathum_checkout_step', { step: ritual ? 'sankalp' : 'details', listing_id: listingId, event_type: eventType });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addFamily() {
    const trimmed = familyInput.trim();
    if (!trimmed || family.length >= 20) return;
    setFamily((f) => [...f, trimmed]);
    setFamilyInput('');
  }
  function removeFamily(i: number) {
    setFamily((f) => f.filter((_, j) => j !== i));
  }

  function submit() {
    if (!name.trim()) { setErr('Enter your name.'); return; }
    setErr(null);
    onContinue(ritual
      ? {
        name: name.trim(),
        gotra: gotra.trim() || undefined,
        family: family.length ? family : undefined,
        wish: wish.trim() || undefined,
      }
      : { name: name.trim() });
  }

  const dots = Array.from({ length: totalSteps }, (_, i) => (
    <i key={i} className={i < stepIndex ? 'on' : ''} />
  ));

  return (
    <div className="sthc-card">
      <button className="sthc-back" onClick={onBack} type="button">&larr; Back</button>
      <div className="sthc-kick">Step {stepIndex} of {totalSteps} · {ritual ? 'Sankalp' : 'Details'}</div>
      <h3 className="sthc-h3">{ritual ? 'Your sankalp' : 'Your name'}</h3>
      <div className="sthc-dots">{dots}</div>

      <div className="sthc-fld">
        <label htmlFor="sthc-name">Your name</label>
        <input id="sthc-name" className="sthc-in" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </div>

      {ritual && (
        <>
          <div className="sthc-fld">
            <label htmlFor="sthc-gotra">Gotra <em>Optional</em></label>
            <input id="sthc-gotra" className="sthc-in" placeholder="e.g. Kashyap" value={gotra} maxLength={60} onChange={(e) => setGotra(e.target.value)} />
          </div>
          <div className="sthc-fld">
            <label>Family names <em>Optional</em></label>
            {family.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                {family.map((f, i) => (
                  <span className="sthc-family-chip" key={`${f}-${i}`}>
                    {f}
                    <button type="button" aria-label={`Remove ${f}`} onClick={() => removeFamily(i)}>&times;</button>
                  </span>
                ))}
              </div>
            )}
            {family.length < 20 && (
              <div className="sthc-family-add">
                <input
                  className="sthc-in"
                  placeholder="Add a family member"
                  value={familyInput}
                  maxLength={60}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addFamily(); } }}
                  onChange={(e) => setFamilyInput(e.target.value)}
                />
                <button type="button" onClick={addFamily}>Add</button>
              </div>
            )}
          </div>
          <div className="sthc-fld">
            <label htmlFor="sthc-wish">Your wish <em>Optional</em></label>
            <input id="sthc-wish" className="sthc-in" placeholder="For my son's board exams" value={wish} maxLength={240} onChange={(e) => setWish(e.target.value)} />
          </div>
        </>
      )}

      {err && <p className="sthc-err" role="alert">{err}</p>}
      <div className="sthc-hint sthc-hint--gold">
        We save {ritual ? 'these' : 'this'} to your profile so next time it&rsquo;s filled in.
      </div>
      <button className="sthc-btn" onClick={submit}>Continue &rarr;</button>
    </div>
  );
}
