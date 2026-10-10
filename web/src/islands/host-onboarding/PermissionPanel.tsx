/* [HF-APP-5] Two small panels shown only inside the Android app, reusing the onboarding step's existing card, button and text classes. */
import { useState } from 'react';
import Icon from './Icon';
import { openAppSettings, type PermKind } from '../../lib/appPermissions';

const WHY: Record<PermKind, string> = {
  camera: 'We need your camera for a 10-second video to prove it’s really you.',
  mic: 'We need your microphone to record your voice introduction.',
};

/** Shown before the Android permission prompt. */
export function PermissionExplainer({ kind, onContinue }: { kind: PermKind; onContinue: () => void }) {
  return (
    <div className="hob-v-camidle" role="group" aria-label={kind === 'camera' ? 'Camera permission' : 'Microphone permission'}>
      <span className="hob-v-ico" aria-hidden="true"><Icon name={kind === 'camera' ? 'video' : 'mic'} /></span>
      <p className="hob-v-strong">{WHY[kind]}</p>
      <p className="hob-help">Your phone will ask you to allow it. Please tap Allow.</p>
      <button type="button" className="hob-btn hob-btn-primary" onClick={onContinue}>Continue</button>
    </div>
  );
}

/** Shown when the person said "Don't allow" (or Android blocked it). */
export function PermissionDenied({ kind, onRetry }: { kind: PermKind; onRetry: () => void }) {
  const [noSettings, setNoSettings] = useState(false);
  const what = kind === 'camera' ? 'camera' : 'microphone';
  return (
    <div className="hob-v-camidle" role="alert">
      <p className="hob-v-strong">The {what} is turned off for this app.</p>
      <p className="hob-help">Open settings, tap Permissions, turn on {what}, then come back and try again.</p>
      <button type="button" className="hob-btn hob-btn-primary" onClick={() => { if (!openAppSettings()) setNoSettings(true); }}>Open settings</button>
      {noSettings && <p className="hob-help">On your phone, open Settings, then Apps, then this app, then Permissions, and allow the {what}.</p>}
      <button type="button" className="hob-btn hob-btn-ghost" onClick={onRetry}>Try again</button>
    </div>
  );
}
