/* InstallPrompt — [DASH2-PWA 2026-09-25] "Add Saa Thum to your home screen".
 *
 * Mounted ONLY from layouts/Dashboard2.astro, so it is also the tiny island that
 * registers the service worker (public/sw.js, scope "/") — dashboard pages only.
 *
 *  - Chromium/Android: captures `beforeinstallprompt` and shows a dismissible
 *    card whose button calls prompt().
 *  - iOS Safari (not already standalone): no install API exists, so the card
 *    shows the Share -> "Add to Home Screen" steps instead.
 *  - Dismissal is remembered in localStorage (try/catch: storage can be blocked).
 *  - Telemetry: dash2_pwa_install {action, platform[, outcome]}.
 */
import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Download, Share, SquarePlus, X } from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { Button } from '../../components/ui/button';

const DISMISS_KEY = 'dash2_pwa_dismissed_at';
const DISMISS_FOR_MS = 30 * 24 * 60 * 60 * 1000; // ask again after 30 days

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform?: string }>;
}

function dismissedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return at > 0 && Date.now() - at < DISMISS_FOR_MS;
  } catch { return false; }
}
function rememberDismiss() {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* storage blocked */ }
}
function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch { return false; }
}
function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);
}

/** Register /sw.js once per page. Skipped in dev and on insecure origins. */
function registerServiceWorker() {
  if (import.meta.env.DEV || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  const go = () => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => captureException(e, { where: 'dash2_sw_register' }));
  if (document.readyState === 'complete') void go();
  else window.addEventListener('load', () => void go(), { once: true });
}

export default function InstallPrompt() {
  const reduce = useReducedMotion();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [mode, setMode] = useState<'none' | 'prompt' | 'ios'>('none');

  useEffect(() => {
    registerServiceWorker();
    if (isStandalone()) return;
    const platform = isIosSafari() ? 'ios' : 'web';

    const onBip = (e: Event) => {
      e.preventDefault(); // keep the browser's mini-infobar away; we show our own card
      setDeferred(e as BeforeInstallPromptEvent);
      if (!dismissedRecently()) {
        setMode('prompt');
        capture('dash2_pwa_install', { action: 'shown', platform });
      }
    };
    const onInstalled = () => {
      setMode('none');
      setDeferred(null);
      capture('dash2_pwa_install', { action: 'installed', platform });
    };
    window.addEventListener('beforeinstallprompt', onBip);
    window.addEventListener('appinstalled', onInstalled);

    let t: ReturnType<typeof setTimeout> | undefined;
    if (platform === 'ios' && !dismissedRecently()) {
      t = setTimeout(() => { setMode('ios'); capture('dash2_pwa_install', { action: 'shown', platform }); }, 2500);
    }
    return () => {
      window.removeEventListener('beforeinstallprompt', onBip);
      window.removeEventListener('appinstalled', onInstalled);
      if (t) clearTimeout(t);
    };
  }, []);

  const dismiss = () => {
    rememberDismiss();
    capture('dash2_pwa_install', { action: 'dismissed', platform: mode === 'ios' ? 'ios' : 'web' });
    setMode('none');
  };

  const install = async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      capture('dash2_pwa_install', { action: 'prompted', platform: 'web', outcome: choice.outcome });
      if (choice.outcome === 'dismissed') rememberDismiss();
    } catch (e) {
      captureException(e, { where: 'dash2_pwa_prompt' });
    } finally {
      setDeferred(null); // a prompt event can be used only once
      setMode('none');
    }
  };

  return (
    <AnimatePresence>
      {mode !== 'none' && (
        <motion.aside
          role="dialog"
          aria-label="Add Saa Thum to your home screen"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }}
          transition={{ duration: reduce ? 0 : 0.25 }}
          className="fixed inset-x-3 z-50 bottom-[calc(var(--dash-tabbar-h,64px)+env(safe-area-inset-bottom,0px)+12px)] sm:inset-x-auto sm:bottom-6 sm:right-6 sm:w-[380px]"
        >
          <div className="dash-surface relative overflow-hidden p-4 shadow-[var(--dash-shadow-lg,none)]">
            <div aria-hidden className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-grand-gold via-grand-red/60 to-grand-teal" />
            <button
              type="button"
              onClick={dismiss}
              aria-label="Not now"
              className="absolute right-2 top-2 inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="flex items-start gap-3 pr-8">
              <img src="/icons/icon-192.png" alt="" width={48} height={48} className="h-12 w-12 shrink-0 rounded-xl shadow-[var(--dash-shadow,none)]" />
              <div className="min-w-0">
                <h2 className="font-dash text-[15.5px] font-bold leading-snug text-grand-teal">Add Saa Thum to your home screen</h2>
                <p className="mt-1 text-[13px] font-semibold text-muted-foreground">Open your pujas in one tap, full screen, like an app.</p>
              </div>
            </div>
            {mode === 'prompt' ? (
              <div className="mt-3 flex gap-2">
                <Button variant="ghost" className="flex-1" onClick={dismiss}>Not now</Button>
                <Button variant="accent" className="flex-1" onClick={() => void install()}><Download /> Install</Button>
              </div>
            ) : (
              <ol className="mt-3 space-y-2 rounded-xl bg-muted/50 p-3 text-[13.5px] font-semibold text-foreground">
                <li className="flex items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[12px] font-extrabold text-accent-foreground">1</span>
                  Tap <Share className="h-4 w-4 text-accent" aria-label="Share" /> <strong className="font-extrabold">Share</strong> in Safari’s toolbar
                </li>
                <li className="flex items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[12px] font-extrabold text-accent-foreground">2</span>
                  Choose <SquarePlus className="h-4 w-4 text-accent" aria-hidden /> <strong className="font-extrabold">Add to Home Screen</strong>
                </li>
              </ol>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
