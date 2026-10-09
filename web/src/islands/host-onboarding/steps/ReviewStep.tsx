import { useEffect } from 'react';
import Icon from '../Icon';
import { GENDER_LABEL, hostShare, rupees, TOPICS } from '../data';
import type { StepKey, StepProps } from '../types';

function Row({ title, step, goTo, children }: { title: string; step: StepKey; goTo: (s: StepKey) => void; children: React.ReactNode }) {
  return (
    <section className="hob-card hob-f-rev">
      <div className="hob-f-rev-head">
        <h2 className="hob-f-h2">{title}</h2>
        <button type="button" className="hob-btn hob-btn-ghost hob-f-edit" onClick={() => goTo(step)} aria-label={`Edit ${title}`}>Edit</button>
      </div>
      <div className="hob-f-rev-body">{children}</div>
    </section>
  );
}

export default function ReviewStep({ draft, update, goTo, avatars, setAction }: StepProps) {
  const a = draft.agreements;
  const all = a.rules && a.agreement && a.welfare;
  useEffect(() => { setAction({ label: 'Create my profile', disabled: !all, run: () => true }); }, [all, setAction]);

  const avatar = avatars.find(x => x.id === draft.avatarId);
  const topics = draft.topics.map(s => TOPICS.find(t => t.slug === s)?.label || s);
  const set = (k: keyof typeof a, v: boolean) => update({ agreements: { ...a, [k]: v } });
  const h = draft.hours;

  return (
    <div>
      <h1 className="hob-h1">Check everything</h1>
      <p className="hob-lead">Have a last look. You can change anything before we make your profile.</p>

      <Row title="Verified" step="phone" goTo={goTo}>
        <ul className="hob-f-list">
          <li><Icon name="check" /> Phone +91 •••••• {draft.phone.slice(-4)}</li>
          <li><Icon name={draft.aadhaarDone ? 'check' : 'x'} /> Aadhaar ending {draft.aadhaarLast4 || '----'}{draft.kycGender ? ` · ${GENDER_LABEL[draft.kycGender]}` : ''}</li>
          <li><Icon name={draft.selfie.recorded ? 'check' : 'x'} /> Selfie video {draft.selfie.recorded ? 'done' : 'not done'}</li>
          <li><Icon name={draft.payout.verified ? 'check' : 'x'} /> Payout: {draft.payout.upi || 'no UPI'}{draft.payout.accountLast4 ? ` · bank ••••${draft.payout.accountLast4}` : ''}{draft.payout.verified ? ' (name matched)' : ''}</li>
        </ul>
      </Row>
      <Row title="Avatar" step="avatar" goTo={goTo}>
        {avatar ? <img className="hob-f-thumb" src={avatar.image} alt="Your chosen avatar" /> : <p>No avatar chosen yet.</p>}
      </Row>
      <Row title="Name & about" step="about" goTo={goTo}>
        <p className="hob-f-strong">{draft.displayName || 'No name yet'}</p>
        <p>{draft.about}</p>
      </Row>
      <Row title="Languages & style" step="languages" goTo={goTo}>
        <p>{draft.languages.join(', ') || 'None chosen'}</p>
        <p>{draft.style || ''}</p>
      </Row>
      <Row title="Topics" step="topics" goTo={goTo}>
        <div className="hob-f-chips">{topics.map(t => <span key={t} className="hob-f-pill">{t}</span>)}</div>
      </Row>
      <Row title="Price" step="price" goTo={goTo}>
        <p><span className="hob-f-strong">{rupees(draft.pricePerMin)} per minute</span> · you get {rupees(hostShare(draft.pricePerMin))}</p>
      </Row>
      <Row title="Hours & comfort" step="hours" goTo={goTo}>
        <p>{h.days.join(', ') || 'No days chosen'} · {h.from} to {h.to}</p>
        <p>{draft.womenOnlyLane ? 'Only women callers' : 'All callers'}</p>
        <p>LGBTQ+ space: {draft.lgbtqLane ? (draft.lgbtqShowOnProfile ? 'Yes (shown on profile)' : 'Yes (private)') : 'No'}</p>
      </Row>
      <Row title="Voice introduction" step="voice" goTo={goTo}>
        <p>{draft.voice.recorded ? `Voice introduction — ${Math.floor(draft.voice.durationSec / 60)}:${String(draft.voice.durationSec % 60).padStart(2, '0')}` : 'Not recorded yet'}</p>
      </Row>

      <div className="hob-f-agree">
        <label className="hob-card hob-f-consent">
          <input type="checkbox" checked={a.rules} onChange={e => set('rules', e.target.checked)} />
          <span>I have read the <a href="/hosts/rules">host rules</a>.</span>
        </label>
        <label className="hob-card hob-f-consent">
          <input type="checkbox" checked={a.agreement} onChange={e => set('agreement', e.target.checked)} />
          <span>I accept the <a href="/hosts/agreement">host agreement</a>.</span>
        </label>
        <label className="hob-card hob-f-consent">
          <input type="checkbox" checked={a.welfare} onChange={e => set('welfare', e.target.checked)} />
          <span>I have read the <a href="/hosts/crisis-script">welfare & crisis guide</a>.</span>
        </label>
      </div>
    </div>
  );
}
