import { useEffect } from 'react';
import Icon from '../Icon';
import type { StepProps } from '../types';

export default function DoneStep({ setAction, api }: StepProps) {
  useEffect(() => { setAction({ label: '', hidden: true }); }, [setAction]);
  const restart = () => {
    try { localStorage.removeItem('hf_host_onboarding_draft_v1'); } catch { /* ignore */ }
    window.location.assign('/hosts/onboarding');
  };
  return (
    <div className="hob-f-done">
      <div className="hob-f-burst" aria-hidden="true">
        <span className="hob-f-dot hob-f-d1" /><span className="hob-f-dot hob-f-d2" /><span className="hob-f-dot hob-f-d3" />
        <span className="hob-f-dot hob-f-d4" /><span className="hob-f-dot hob-f-d5" /><span className="hob-f-dot hob-f-d6" />
        <span className="hob-f-badge"><Icon name="heart" /></span>
      </div>
      <h1 className="hob-h1">Sent for review!</h1>
      <p className="hob-lead">Our team checks every new profile, usually within 24 hours. We'll message you on WhatsApp when you're live.</p>
      <section className="hob-card hob-f-next">
        <h2 className="hob-f-h2">What happens next</h2>
        <ul className="hob-f-list">
          <li><Icon name="clock" /> Go online from your dashboard whenever you like.</li>
          <li><Icon name="phone" /> Calls ring your phone. Your number stays private.</li>
          <li><Icon name="shield" /> You can decline any call.</li>
        </ul>
      </section>
      <a className="hob-btn hob-btn-primary hob-f-full" href="/hosts/dashboard">Go to my host dashboard</a>
      {api.mode === 'mock' && <button type="button" className="hob-btn hob-btn-ghost hob-f-full" onClick={restart}>Start the preview again</button>}
    </div>
  );
}
