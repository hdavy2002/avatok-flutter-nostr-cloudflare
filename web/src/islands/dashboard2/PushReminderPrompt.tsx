/* PushReminderPrompt — [DASH2-PUSH 2026-09-26] one-tap "Get reminders" on My events.
 *
 * Shown only when the person has an upcoming/live booking, this device is not yet
 * subscribed, and the browser hasn't blocked notifications. iPhone/iPad Safari tabs
 * (no web push outside a home-screen app) get the install hint instead of a button.
 * Dismissal is remembered for 14 days (localStorage, try/catch).
 */
import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { BellRing, Loader2, X } from 'lucide-react';
import { capture } from '../../lib/analytics';
import { Button } from '../../components/ui/button';
import { toast } from '../../components/ui/sonner';
import { meApi } from './accountApi';
import { currentSubscription, enablePush, IOS_INSTALL_HINT, permission, pushSupport, pushPlatform } from './webPush';

const DISMISS_KEY = 'dash2_push_prompt_dismissed_at';
const DISMISS_FOR_MS = 14 * 24 * 60 * 60 * 1000;

function dismissedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return at > 0 && Date.now() - at < DISMISS_FOR_MS;
  } catch { return false; }
}

export default function PushReminderPrompt() {
  const reduce = useReducedMotion();
  const [mode, setMode] = useState<'none' | 'ask' | 'ios'>('none');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      const support = pushSupport();
      if (support === 'unsupported' || dismissedRecently()) return;
      if (support === 'supported' && (permission() === 'denied' || (await currentSubscription()))) return;
      const r = await meApi<{ items?: { state?: string }[] }>('/api/me/events', { query: { scope: 'upcoming' } }).catch(() => null);
      const upcoming = (r?.items ?? []).some((i) => i.state === 'upcoming' || i.state === 'live');
      if (!live || !upcoming) return;
      setMode(support === 'ios_needs_install' ? 'ios' : 'ask');
      capture('dash2_push_prompt', { action: 'shown', platform: pushPlatform() });
    })();
    return () => { live = false; };
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* storage blocked */ }
    capture('dash2_push_prompt', { action: 'dismissed', platform: pushPlatform() });
    setMode('none');
  };

  const enable = async () => {
    setBusy(true);
    setMsg('');
    const r = await enablePush();
    setBusy(false);
    if (r.ok) {
      toast.success('Reminders are on. We’ll ping you 15 minutes before and when it goes live.');
      setMode('none');
    } else setMsg(r.message);
  };

  return (
    <AnimatePresence>
      {mode !== 'none' && (
        <motion.section
          aria-label="Get reminders"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.2 }}
          className="dash-surface relative mb-4 overflow-hidden p-4 font-dashbody sm:p-5"
        >
          <div aria-hidden className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-grand-gold via-grand-red/60 to-grand-teal" />
          <button
            type="button"
            onClick={dismiss}
            aria-label="Not now"
            className="absolute right-2 top-2 inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex flex-col gap-3 pr-8 sm:flex-row sm:items-center">
            <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><BellRing className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <h2 className="font-dash text-[15.5px] font-bold leading-snug text-grand-teal">Never miss the aarti</h2>
              <p className="mt-0.5 text-[13px] font-semibold text-muted-foreground">
                {mode === 'ios' ? IOS_INSTALL_HINT : 'Get a reminder 15 minutes before your ritual and when it goes live.'}
              </p>
              {msg && <p role="status" className="mt-1 text-[12.5px] font-bold text-primary">{msg}</p>}
            </div>
            {mode === 'ask' && (
              <Button variant="accent" className="sm:min-w-[150px]" disabled={busy} onClick={() => void enable()}>
                {busy ? <Loader2 className="animate-spin" /> : <BellRing />} Get reminders
              </Button>
            )}
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
