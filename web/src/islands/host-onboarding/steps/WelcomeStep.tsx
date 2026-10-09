import { useEffect } from 'react';
import { BRAND } from '../../../lib/brand';
import Icon, { type IconName } from '../Icon';
import type { StepProps } from '../types';

const NEEDS: { icon: IconName; text: string }[] = [
  { icon: 'phone', text: 'Your own phone with WhatsApp' },
  { icon: 'id', text: 'Your Aadhaar card' },
  { icon: 'clock', text: '10 minutes of your time' },
  { icon: 'mic', text: 'A quiet place to record your voice' },
];

export default function WelcomeStep({ setAction, goNext }: StepProps) {
  useEffect(() => {
    setAction({ label: 'Start', hidden: true });
  }, [setAction]);

  return (
    <div className="hob-v-welcome">
      <p className="hob-v-eyebrow">{BRAND.name} hosts</p>
      <h1 className="hob-h1">Earn from home by talking to people</h1>
      <p className="hob-lead">
        Listen, chat and be a friendly voice for people who want to talk. You pick your price and your hours.
      </p>
      <p className="hob-lead hob-v-hinglish">Ghar baithe kamaayein — bas baat karke.</p>

      <section className="hob-card" aria-labelledby="hob-v-need">
        <h2 id="hob-v-need" className="hob-v-h2">What you need</h2>
        <ul className="hob-v-list">
          {NEEDS.map((n) => (
            <li key={n.text}>
              <span className="hob-v-ico" aria-hidden="true"><Icon name={n.icon} /></span>
              <span>{n.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="hob-card hob-v-privacy" aria-labelledby="hob-v-priv">
        <h2 id="hob-v-priv" className="hob-v-h2">
          <span className="hob-v-ico" aria-hidden="true"><Icon name="shield" /></span> Our privacy promise
        </h2>
        <p>Your face and real photos are never shown. You pick an AI avatar; callers never see your number.</p>
      </section>

      <ul className="hob-v-facts">
        <li><Icon name="check" /> 18+ only</li>
        <li><Icon name="rupee" /> You choose your price</li>
        <li><Icon name="phone" /> Calls come to your phone, no app needed</li>
      </ul>

      <button type="button" className="hob-btn hob-btn-primary hob-v-start" onClick={goNext}>Start</button>
      <p className="hob-v-rules"><a href="/hosts/rules">Read host rules</a></p>
    </div>
  );
}
