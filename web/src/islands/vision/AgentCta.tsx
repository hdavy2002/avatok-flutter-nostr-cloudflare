// AgentCta — the action island on the PUBLIC vision agent page.
//
// Ownership boundary (PHASE-4 §3): the live session is Phase 5. So this island
// does NOT start a call or open the gate — it presents the language picker +
// "Talk now / Book" CTA and routes to the Phase-5 session route
// `/vision/session/<id>` (the gate fires there, at the action). It polls
// availability so the CTA flips to "Agent busy" when all slots are full.

import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { getAvailability } from './avavisionApi';

// Phase-Z finalizes the exact session path; Phase 4/5 cross-link via this string.
const SESSION_ROUTE = '/vision/session';

// Friendly subset of Gemini Live output languages (mirrors islands/agent).
const LANGS: Array<[string, string]> = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['es-ES', 'Spanish'],
  ['pt-BR', 'Portuguese (BR)'],
  ['fr-FR', 'French'],
  ['de-DE', 'German'],
  ['hi-IN', 'Hindi'],
  ['ar-XA', 'Arabic'],
  ['ja-JP', 'Japanese'],
  ['ko-KR', 'Korean'],
  ['cmn-CN', 'Mandarin'],
];

function defaultLang(): string {
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  const hit = LANGS.find(
    ([code]) => code.toLowerCase() === nav.toLowerCase() || code.split('-')[0] === nav.split('-')[0],
  );
  return hit?.[0] ?? 'en-US';
}

export interface AgentCtaProps {
  agentId: string;
  /** SSR-seeded "free to call" hint for the helper line. */
  free?: boolean;
  /** SSR-seeded busy hint; refined by the live poll. */
  initialBusy?: boolean;
}

export function AgentCta({ agentId, free = false, initialBusy = false }: AgentCtaProps) {
  const [language, setLanguage] = useState('en-US');
  const [busy, setBusy] = useState(initialBusy);
  // Guard the navigation against double-tap (idempotency on the client, §Idempotency).
  const navigating = useRef(false);

  useEffect(() => setLanguage(defaultLang()), []);

  // Live availability poll.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const av = await getAvailability(agentId);
        if (!cancelled) setBusy(av.busy);
      } catch {
        /* keep last known state */
      }
    };
    void poll();
    const h = setInterval(() => void poll(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [agentId]);

  const go = (mode: 'now' | 'book') => {
    if (navigating.current) return;
    navigating.current = true;
    const params = new URLSearchParams({ lang: language });
    if (mode === 'book') params.set('mode', 'book');
    window.location.href = `${SESSION_ROUTE}/${encodeURIComponent(agentId)}?${params.toString()}`;
  };

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <label className="flex w-full max-w-xs flex-col gap-1.5">
        <span className="font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">
          Coach me in
        </span>
        <select
          className="w-full rounded-zineField border-zine border-ink bg-card px-3.5 py-2.5 font-body font-bold text-[15px] text-ink shadow-zine-xs outline-none"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          {LANGS.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <div className="flex w-full max-w-xs flex-col gap-2.5">
        <Button
          variant="lime"
          fullWidth
          disabled={busy}
          label={busy ? 'Agent busy — try soon' : 'Talk now'}
          onClick={() => go('now')}
        />
        <Button variant="blue" fullWidth label="Book a time" onClick={() => go('book')} />
      </div>

      <p className="max-w-xs text-center font-body text-[12px] text-inkMute">
        Camera + mic access required. You'll grant camera consent on the next screen.
        {' '}
        {free ? 'Free to use — the creator covers it.' : 'Billed per minute from your AvaWallet.'}
      </p>
    </div>
  );
}

/** Exported island. No ClerkIsland here — the gate lives on the session page. */
export default function AgentCtaIsland(props: AgentCtaProps) {
  return <AgentCta {...props} />;
}
