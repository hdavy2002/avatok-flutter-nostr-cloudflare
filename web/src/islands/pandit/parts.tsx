/* [AUMFE-PANDIT-WEB-1] Presentational parts of /pandit: sign-in gate, birth-details card, kundli + memory panels,
 * product/puja cards and the "Why this?" sheet. Built to the approved mockups (Gate / Onboard / Phone / Tablet / Chat).
 * No data fetching here — Pandit.tsx owns state and calls. Brand name only through BRAND. */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { BRAND } from '../../lib/brand';
import { publicImage } from '../../lib/config';
import { safeHref } from '../preeti/richText';
import type { Card, PanditChart, PanditMemory, PanditProfile, ProfileInput, WhyStep } from './types';

export const PANDIT_IMG = '/images/pandit-ji.jpg';
export const WHY_HELP_HREF = '/help/talk-to-a-guide/why-this-design';

const STEP_LABEL: Record<WhyStep['step'], string> = {
  deity: 'Deity on the design',
  chakra: 'Chakra',
  print_colour: 'Colour of the print',
  shirt_colour: 'Shirt colour',
};

export function rupees(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

export function PanditAvatar({ size, className }: { size: number; className?: string }) {
  return <img className={`pd-avatar ${className ?? ''}`} src={publicImage(PANDIT_IMG, { width: size > 64 ? 256 : 96, fit: 'cover' })} alt="Pandit ji" width={size} height={size} style={{ width: size, height: size }} decoding="async" />;
}

/* ── Gate (mockup Gate.dc.html) ─────────────────────────────────────────── */

const Tick = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1f7a45" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
);

export function SignInGate({ signInHref, onClick }: { signInHref: string; onClick: (method: 'whatsapp' | 'google') => void }) {
  return (
    <section className="pd-gate" aria-labelledby="pd-gate-h">
      <PanditAvatar size={112} className="pd-gate-avatar" />
      <h1 id="pd-gate-h" className="pd-hd pd-gate-title">Pranam! Sign in to talk to Pandit ji</h1>
      <p className="pd-gate-lede">So Pandit ji can keep your kundli safe and remember what he told you last time.</p>
      <ul className="pd-gate-list">
        <li><Tick />First consultation free</li>
        <li><Tick />Your chart and chats stay private</li>
        <li><Tick />Talk in Hindi, English or your language</li>
      </ul>
      <div className="pd-gate-btns">
        <a className="pd-btn pd-btn-green" href={signInHref} onClick={() => onClick('whatsapp')}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 21l1.6-4.7A8.5 8.5 0 1 1 8 19.6z" /></svg>
          Continue with WhatsApp
        </a>
        <a className="pd-btn pd-btn-outline" href={signInHref} onClick={() => onClick('google')}>Continue with Google</a>
      </div>
      <p className="pd-gate-fine">Uses your existing {BRAND.name} account. Guidance is spiritual and traditional, not a guarantee.</p>
    </section>
  );
}

/* ── Birth details (mockup Onboard.dc.html) ─────────────────────────────── */

export function BirthCard({ firstName, profile, initialConsent, busy, error, onSubmit }: {
  firstName: string | null; profile: PanditProfile | null; initialConsent: boolean; busy: boolean; error: string | null;
  onSubmit: (p: ProfileInput, consent: boolean) => void;
}) {
  const [dob, setDob] = useState(profile?.dob ?? '');
  const [tob, setTob] = useState(profile?.tob ?? '');
  const [tobUnknown, setTobUnknown] = useState(!!profile?.tob_unknown);
  const [place, setPlace] = useState(profile?.place ?? '');
  const [consent, setConsent] = useState(initialConsent);
  const [problem, setProblem] = useState<string | null>(null);
  const name = (profile?.name || firstName || '').trim();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!dob) return setProblem('Please add your date of birth.');
    if (!tobUnknown && !tob) return setProblem('Please add your time of birth, or tick “Exact time not known”.');
    if (!place.trim()) return setProblem('Please add your place of birth.');
    setProblem(null);
    onSubmit({ name, dob, tob: tobUnknown ? null : tob, tob_unknown: tobUnknown, place: place.trim() }, consent);
  }

  return (
    <div className="pd-onboard">
      <div className="pd-bubble pd-bubble-bot">Pranam{name ? ` ${name} ji` : ' ji'}! Main aapki kundli dekh kar hi sahi salah de sakta hoon. Apna janm vivaran bataiye.</div>
      <form className="pd-form" onSubmit={submit} noValidate>
        <h1 className="pd-hd pd-form-title">Janm vivaran · Birth details</h1>
        <label className="pd-field"><span>Date of birth</span>
          <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} max={new Date().toISOString().slice(0, 10)} min="1900-01-01" autoComplete="bday" required />
        </label>
        <label className="pd-field"><span>Time of birth</span>
          <input type="time" value={tobUnknown ? '' : tob} onChange={(e) => setTob(e.target.value)} disabled={tobUnknown} />
        </label>
        <label className="pd-check"><input type="checkbox" checked={tobUnknown} onChange={(e) => setTobUnknown(e.target.checked)} />Exact time not known</label>
        <label className="pd-field"><span>Place of birth</span>
          <input type="text" value={place} onChange={(e) => setPlace(e.target.value)} placeholder="City, state" autoComplete="off" maxLength={120} />
        </label>
        <label className="pd-check pd-check-consent"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />Let Pandit ji remember our talks</label>
        {(problem || error) && <p className="pd-problem" role="alert">{problem || error}</p>}
        <button type="submit" className="pd-btn pd-btn-red pd-form-submit" disabled={busy}>{busy ? 'Ek minute…' : 'Meri kundli banaiye'}</button>
      </form>
      <div className="pd-pill">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        Saved to your profile — asked only once
      </div>
    </div>
  );
}

/* ── Kundli + memory (mockup Chat.dc.html aside, Tablet strip) ──────────── */

function fmtBirth(p: PanditProfile | null): string {
  if (!p?.dob) return '';
  const [y, m, d] = p.dob.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const date = y && m && d ? `${d} ${months[m - 1]} ${y}` : p.dob;
  return [date, p.tob_unknown ? 'time not known' : p.tob, p.place].filter(Boolean).join(' · ');
}

export function KundliPanel({ profile, chart, onEdit }: { profile: PanditProfile | null; chart: PanditChart | null; onEdit: () => void }) {
  return (
    <section className="pd-panel" aria-label="Your kundli">
      <div className="pd-panel-head">
        <h2 className="pd-hd">Aapki kundli</h2>
        <button type="button" className="pd-link" onClick={onEdit}>Edit</button>
      </div>
      <p className="pd-panel-sub">{fmtBirth(profile)}</p>
      {chart ? (
        <>
          <dl className="pd-dl">
            <div><dt>Lagna</dt><dd>{chart.lagna}</dd></div>
            <div><dt>Moon sign</dt><dd>{chart.moon_sign}</dd></div>
            <div><dt>Nakshatra</dt><dd>{chart.nakshatra}</dd></div>
            <div><dt>Dasha</dt><dd>{chart.dasha}</dd></div>
          </dl>
          {chart.doshas.length > 0 && (
            <div className="pd-tags">{chart.doshas.map((d) => <span key={d} className="pd-tag pd-tag-red">{d}</span>)}</div>
          )}
          <p className="pd-fine">Chart computed by our astrology engine — not guessed by AI.</p>
        </>
      ) : (
        <p className="pd-fine">Your chart is being prepared. It will appear here after your first message.</p>
      )}
    </section>
  );
}

const MEM_DOT = ['pd-dot-red', 'pd-dot-gold', 'pd-dot-teal', 'pd-dot-brown'];

export function MemoryPanel({ memories, consent, onDelete }: { memories: PanditMemory[]; consent: boolean; onDelete: (id: string) => void }) {
  return (
    <section className="pd-panel" aria-label="What Pandit ji remembers">
      <h2 className="pd-hd">Pandit ji remembers</h2>
      {memories.length === 0 ? (
        <p className="pd-fine">{consent ? 'Nothing yet. As you talk, Pandit ji will note what matters.' : 'Memory is off. Pandit ji will not keep notes between talks.'}</p>
      ) : (
        <ul className="pd-mem-list">
          {memories.map((m, i) => (
            <li key={m.id}>
              <span className={`pd-dot ${MEM_DOT[i % MEM_DOT.length]}`} aria-hidden="true" />
              <span className="pd-mem-text">{m.text}</span>
              <button type="button" className="pd-mem-del" aria-label={`Forget: ${m.text}`} onClick={() => onDelete(m.id)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── Product / puja cards ───────────────────────────────────────────────── */

export function CardView({ card, onWhy, onAdd }: { card: Card; onWhy: (c: Card, opener: HTMLElement | null) => void; onAdd: (c: Card) => void }) {
  const href = safeHref(card.url) ?? '#';
  if (card.kind === 'puja') {
    return (
      <article className="pd-card pd-card-puja">
        <span className="pd-card-kicker">LIVE HAVAN</span>
        <strong className="pd-card-puja-title">{card.title}</strong>
        {card.wear_days.length > 0 && <span className="pd-card-puja-sub">{card.wear_days.join(' · ')}</span>}
        <span className="pd-card-price pd-card-price-puja">{rupees(card.price_inr)}</span>
        <a className="pd-card-btn pd-card-btn-gold" href={href} onClick={() => onAdd(card)}>Book my seat</a>
      </article>
    );
  }
  const sub = [card.chakra || card.deity, card.wear_days.length ? card.wear_days.join(' & ') : ''].filter(Boolean).join(' · ');
  return (
    <article className="pd-card">
      <div className="pd-card-img">{card.image_url ? <img src={card.image_url} alt="" loading="lazy" decoding="async" /> : null}</div>
      <strong className="pd-card-title">{card.title}</strong>
      {sub && <span className="pd-card-sub">{sub}</span>}
      <span className="pd-card-price">{rupees(card.price_inr)}</span>
      <button type="button" className="pd-card-btn pd-card-btn-ghost" onClick={(e) => onWhy(card, e.currentTarget)}>Why this?</button>
      <a className="pd-card-btn pd-card-btn-red" href={href} onClick={() => onAdd(card)}>Add to cart</a>
    </article>
  );
}

/* ── Why this? (bottom sheet on phone, dialog from 768px) — mockup Phone.dc.html ── */

export function WhySheet({ card, onClose, onAdd }: { card: Card; onClose: () => void; onAdd: (c: Card) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const f = Array.from(ref.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled])'));
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  const href = safeHref(card.url) ?? '#';
  return (
    <div className="pd-sheet-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section ref={ref} className="pd-sheet" role="dialog" aria-modal="true" aria-labelledby="pd-why-h">
        <span className="pd-sheet-grip" aria-hidden="true" />
        <div className="pd-sheet-top">
          <div className="pd-sheet-img">{card.image_url ? <img src={card.image_url} alt="" decoding="async" /> : null}</div>
          <div className="pd-sheet-titles">
            <h2 id="pd-why-h" className="pd-hd">Why this design?</h2>
            <span>{card.title}</span>
          </div>
        </div>
        <ol className="pd-why-list">
          {card.why.map((w, i) => (
            <li key={`${w.step}-${i}`}>
              <span className={`pd-why-n ${w.step === 'shirt_colour' ? 'pd-why-n-sage' : ''}`}>{i + 1}</span>
              <div><strong>{STEP_LABEL[w.step] ?? w.step}</strong><br /><span>{w.fact}</span></div>
            </li>
          ))}
        </ol>
        <div className="pd-tags">
          {card.wear_days.length > 0 && <span className="pd-tag pd-tag-red">Wear on: {card.wear_days.join(', ')}</span>}
          {card.tradition_note && <span className="pd-tag pd-tag-sage">{card.tradition_note}</span>}
        </div>
        <p className="pd-fine">Linked by tradition, not a promise of results. <a href={WHY_HELP_HREF}>How suggestions work</a></p>
        <div className="pd-sheet-actions">
          <button ref={closeRef} type="button" className="pd-card-btn pd-card-btn-ghost" onClick={onClose}>Close</button>
          <a className="pd-card-btn pd-card-btn-red pd-sheet-add" href={href} onClick={() => onAdd(card)}>Add to cart · {rupees(card.price_inr)}</a>
        </div>
      </section>
    </div>
  );
}

/* ── Panels drawer (phone ☰ and tablet “Details & memory”) ──────────────── */

export function PanelsDrawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="pd-sheet-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pd-sheet pd-drawer" role="dialog" aria-modal="true" aria-label="Your kundli and memory">
        <span className="pd-sheet-grip" aria-hidden="true" />
        {children}
        <button ref={closeRef} type="button" className="pd-card-btn pd-card-btn-ghost pd-drawer-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
