/* Small shared presentation bits for the influencer screens (banner + count). Presentation only. */
import type { ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import '../../../styles/hf-admin-hosts.css';

export function HBanner({ tone, children }: { tone: 'error' | 'info'; children: ReactNode }) {
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`hfh-banner ${tone}`}>{children}</div>;
}
/** Tick chip for a checklist item. */
export function Tick({ on, children }: { on: boolean; children: ReactNode }) {
  return <span className={`hfh-tick ${on ? 'on' : 'off'}`}>{on ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}<span className="sr-only">{on ? 'Done: ' : 'Missing: '}</span>{children}</span>;
}
