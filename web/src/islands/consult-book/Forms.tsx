/* [AUMFE-CONSULT-F2-1 2026-10-02] Step 1 — details form per discipline (mockups BookDetails / BookNumerology;
 * palmistry, face and tarot detail forms use the same field language). Controlled components: the wizard owns the state. */
import type { ReactNode } from 'react';
import { DISCIPLINE_LABEL } from '../../lib/consultTypes';
import { BRAND } from '../../lib/brand';
import {
  EMPTY_BIRTH, FOCUS_OPTIONS, MARITAL_OPTIONS, bhagyank, moolank, toDeva,
} from './bookLogic';
import type { AstroForm, BirthForm, FaceForm, NumeroForm, PalmForm, TarotForm } from './bookLogic';

export function Field({ id, label, hint, children }: { id?: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function FocusChips({ value, onChange, label = 'What do you want to talk about?' }: { value: string[]; onChange: (v: string[]) => void; label?: string }) {
  return (
    <div className="field">
      <span className="cb-label">{label}</span>
      <div className="cb-chips">
        {FOCUS_OPTIONS.map((o) => {
          const on = value.includes(o);
          return (
            <button key={o} type="button" className={`slot${on ? ' on' : ''}`} aria-pressed={on}
              onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}>{o}</button>
          );
        })}
      </div>
    </div>
  );
}

function Gender({ id, value, onChange, allowEmpty = false }: { id: string; value: string; onChange: (v: string) => void; allowEmpty?: boolean }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allowEmpty ? 'Prefer not to say' : 'Choose…'}</option>
      <option value="male">Male</option>
      <option value="female">Female</option>
      <option value="other">Other</option>
    </select>
  );
}

function BirthFields({ idp, b, set, partner = false }: { idp: string; b: BirthForm; set: (b: BirthForm) => void; partner?: boolean }) {
  const up = (patch: Partial<BirthForm>) => set({ ...b, ...patch });
  return (
    <>
      <Field id={`${idp}n`} label={partner ? 'Partner’s full name' : 'Full name'}>
        <input id={`${idp}n`} value={b.name} autoComplete={partner ? 'off' : 'name'} onChange={(e) => up({ name: e.target.value })} maxLength={80} />
      </Field>
      <div className="cb-two">
        <Field id={`${idp}g`} label="Gender"><Gender id={`${idp}g`} value={b.gender} onChange={(v) => up({ gender: v as BirthForm['gender'] })} /></Field>
        <Field id={`${idp}dob`} label="Date of birth">
          <input id={`${idp}dob`} type="date" value={b.dob} min="1900-01-01" max={new Date().toISOString().slice(0, 10)} autoComplete={partner ? 'off' : 'bday'} onChange={(e) => up({ dob: e.target.value })} />
        </Field>
      </div>
      <div className="field">
        <label htmlFor={`${idp}tob`}>Time of birth</label>
        <input id={`${idp}tob`} type="time" value={b.tobUnknown ? '' : b.tob} disabled={b.tobUnknown} onChange={(e) => up({ tob: e.target.value })} />
        <label className="cb-check"><input type="checkbox" checked={b.tobUnknown} onChange={(e) => up({ tobUnknown: e.target.checked })} /> I don&rsquo;t know my birth time</label>
      </div>
      <Field id={`${idp}pob`} label="Place of birth" hint={b.geo ? `${b.geo.lat.toFixed(2)}°N · ${b.geo.lon.toFixed(2)}°E — from your saved profile` : 'City and state. We find the coordinates and time zone for you.'}>
        <input id={`${idp}pob`} value={b.place} placeholder="City, state" autoComplete="off" maxLength={120}
          onChange={(e) => up({ place: e.target.value, geo: null })} />
      </Field>
    </>
  );
}

export function AstroDetails({ f, set, prefilled, consultant }: { f: AstroForm; set: (f: AstroForm) => void; prefilled: boolean; consultant: string }) {
  return (
    <>
      {prefilled && (
        <div className="card cb-note">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#07545b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
          <span>Filled from your saved profile — check and continue.</span>
        </div>
      )}
      <BirthFields idp="a-" b={f.birth} set={(birth) => set({ ...f, birth })} />
      <div className="cb-two">
        <Field id="a-gotra" label="Gotra"><input id="a-gotra" value={f.gotra} maxLength={60} onChange={(e) => set({ ...f, gotra: e.target.value })} /></Field>
        <Field id="a-ms" label="Marital status">
          <select id="a-ms" value={f.marital} onChange={(e) => set({ ...f, marital: e.target.value })}>
            <option value="">Choose…</option>
            {MARITAL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
      </div>
      <Field id="a-city" label="Where you live now"><input id="a-city" value={f.city} maxLength={80} onChange={(e) => set({ ...f, city: e.target.value })} /></Field>
      <FocusChips value={f.focus} onChange={(focus) => set({ ...f, focus })} />
      <details className="card cb-more" open={f.partnerOn} onToggle={(e) => { const open = (e.currentTarget as HTMLDetailsElement).open; if (open !== f.partnerOn) set({ ...f, partnerOn: open, partner: open && !f.partner.name ? { ...EMPTY_BIRTH } : f.partner }); }}>
        <summary>Add a partner&rsquo;s birth details (for matching)</summary>
        <div className="cb-stack">
          <p className="hint">Name, date, time and place of birth — optional.</p>
          {f.partnerOn && <BirthFields idp="p-" b={f.partner} set={(partner) => set({ ...f, partner })} partner />}
        </div>
      </details>
      <p className="hint cb-center">Your details go only to {consultant} and are used to prepare your chart.</p>
    </>
  );
}

export function NumeroDetails({ f, set, consultant }: { f: NumeroForm; set: (f: NumeroForm) => void; consultant: string }) {
  const m = moolank(f.dob);
  const b = bhagyank(f.dob);
  return (
    <>
      <Field id="n-bn" label="Full name, as on your documents"><input id="n-bn" value={f.birthName} autoComplete="name" maxLength={80} onChange={(e) => set({ ...f, birthName: e.target.value })} /></Field>
      <Field id="n-un" label="Name you use day to day" hint="Leave blank if it's the same"><input id="n-un" value={f.usedName} maxLength={80} onChange={(e) => set({ ...f, usedName: e.target.value })} /></Field>
      <Field id="n-dob" label="Date of birth"><input id="n-dob" type="date" value={f.dob} min="1900-01-01" max={new Date().toISOString().slice(0, 10)} onChange={(e) => set({ ...f, dob: e.target.value })} /></Field>
      <Field id="n-mob" label="Mobile number to check" hint="The number you want checked — leave blank to skip">
        <input id="n-mob" type="tel" inputMode="tel" value={f.mobile} maxLength={20} onChange={(e) => set({ ...f, mobile: e.target.value })} />
      </Field>
      <div className="field">
        <span className="cb-label">Names to check (optional)</span>
        <div className="cb-stack" style={{ gap: 8 }}>
          {f.names.map((n, i) => (
            <input key={i} className="cb-input" aria-label={`Name to check ${i + 1}`} value={n} maxLength={80}
              onChange={(e) => set({ ...f, names: f.names.map((x, j) => (j === i ? e.target.value : x)) })} />
          ))}
          {f.names.length < 5 && <button type="button" className="edit left" onClick={() => set({ ...f, names: [...f.names, ''] })}>+ Add a business, child&rsquo;s or house name</button>}
        </div>
      </div>
      <div className="preview cb-numprev" aria-live="polite">
        <div className="col"><span className="cap">MOOLANK</span><span className="deva">{m ? toDeva(m) : '—'}</span></div>
        <div className="col"><span className="cap">BHAGYANK</span><span className="deva">{b ? toDeva(b) : '—'}</span></div>
        <span className="txt">A first look — {consultant} works out the rest before your call.</span>
      </div>
    </>
  );
}

export function PalmDetails({ f, set }: { f: PalmForm; set: (f: PalmForm) => void }) {
  return (
    <>
      <div className="field">
        <span className="cb-label">Which hand do you write with?</span>
        <div className="cb-chips">
          {(['right', 'left'] as const).map((h) => (
            <button key={h} type="button" className={`slot${f.hand === h ? ' on' : ''}`} aria-pressed={f.hand === h} onClick={() => set({ ...f, hand: h })}>{h === 'right' ? 'Right hand' : 'Left hand'}</button>
          ))}
        </div>
        <span className="hint">The dominant hand is read first; a photo of the other palm is optional.</span>
      </div>
      <div className="cb-two">
        <Field id="p-age" label="Your age"><input id="p-age" inputMode="numeric" value={f.age} maxLength={3} onChange={(e) => set({ ...f, age: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field id="p-g" label="Gender"><Gender id="p-g" value={f.gender} allowEmpty onChange={(v) => set({ ...f, gender: v })} /></Field>
      </div>
      <Field id="p-occ" label="What do you do?" hint="Work or study — optional"><input id="p-occ" value={f.occupation} maxLength={80} onChange={(e) => set({ ...f, occupation: e.target.value })} /></Field>
      <FocusChips value={f.focus} onChange={(focus) => set({ ...f, focus })} />
    </>
  );
}

export function FaceDetails({ f, set }: { f: FaceForm; set: (f: FaceForm) => void }) {
  return (
    <>
      <div className="cb-two">
        <Field id="f-g" label="Gender"><Gender id="f-g" value={f.gender} allowEmpty onChange={(v) => set({ ...f, gender: v })} /></Field>
        <Field id="f-dob" label="Date of birth"><input id="f-dob" type="date" value={f.dob} min="1900-01-01" max={new Date().toISOString().slice(0, 10)} onChange={(e) => set({ ...f, dob: e.target.value })} /></Field>
      </div>
      <FocusChips value={f.focus} onChange={(focus) => set({ ...f, focus })} />
      <p className="hint">Next you take a clear photo of your face. It stays private and is read only by your consultant.</p>
    </>
  );
}

export function TarotDetails({ f, set }: { f: TarotForm; set: (f: TarotForm) => void }) {
  return (
    <>
      <Field id="t-name" label="Your name"><input id="t-name" value={f.name} autoComplete="name" maxLength={80} onChange={(e) => set({ ...f, name: e.target.value })} /></Field>
      <Field id="t-dob" label="Date of birth" hint="Optional"><input id="t-dob" type="date" value={f.dob} min="1900-01-01" max={new Date().toISOString().slice(0, 10)} onChange={(e) => set({ ...f, dob: e.target.value })} /></Field>
      <p className="hint">Next you shuffle the deck and draw your own cards. {BRAND.name} keeps them exactly as you drew them.</p>
    </>
  );
}

export const stepTitle = (d: string): string =>
  d === 'numerology' ? 'Names and numbers' : d === 'tarot' ? 'About you' : d === 'astrology' ? 'Your birth details' : 'About you';
export const disciplineLabel = (d: keyof typeof DISCIPLINE_LABEL): string => DISCIPLINE_LABEL[d].en;
