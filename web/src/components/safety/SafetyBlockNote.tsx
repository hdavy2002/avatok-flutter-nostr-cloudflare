/* [HF-CALL-SAFETY-WEB] Friendly text + a link for the 403s `account_paused` / `call_rules_required` (going Online, calling, booking, joining a queue). */
import { useEffect } from 'react';
import { capture } from '../../lib/analytics';
import { SAFETY_EVENTS, safetyBlock } from '../../lib/hfSafetyApi';
import '../../styles/hf-safety.css';

export default function SafetyBlockNote({ code, surface, audience = 'influencer' }: { code: string; surface: string; audience?: 'influencer' | 'fan' }) {
  const b = safetyBlock(code, audience);
  useEffect(() => { if (b) capture(SAFETY_EVENTS.blocked, { code, surface, audience }); }, [b, code, surface, audience]);
  if (!b) return null;
  return <div className="hsf hsf-block" role="alert"><span>{b.text}</span><a href={b.href}>{b.label}</a></div>;
}
