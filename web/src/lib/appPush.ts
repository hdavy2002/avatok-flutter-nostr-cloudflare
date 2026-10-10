/* [HF-APP-4] Push notifications inside the Android app shell. Loaded by lib/appMode.ts, so it only ever runs in app mode.
 * Flow: signed in -> one friendly explainer sheet (Allow / Not now) -> Android permission prompt -> FCM register -> send the token to the worker.
 * A tap on a notification opens its page (same site only). Every plugin call is guarded: a missing plugin or blocked storage never throws. */
import { appPlugins, isAppMode } from './nativeBridge';
import { capture, captureException } from './analytics';
import { hfCall, looksSignedOut } from './hfCallsApi';

const ASKED_KEY = 'hf_push_asked';        // '1' = answered Allow (or the OS prompt); a number = "Not now" at that time (ms)
const TOKEN_KEY = 'hf_push_token';        // last token we sent, so sign-out can remove it
const LATER_MS = 14 * 24 * 3600 * 1000;   // ask again after "Not now" once this long has passed
export const PUSH_CHANNEL_ID = 'hf_default'; // same id as the Android manifest meta-data and the worker's FCM payload

let started = false;
let sheet: HTMLElement | null = null;
let registering = false;

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* storage blocked: the sheet may show again next visit */ } },
  del(k: string): void { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/** Same-site relative path only (mirrors worker safePushPath). Returns null for anything else. */
export function samePath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length < 1 || p.length > 300) return null;
  if (p[0] !== '/' || p[1] === '/' || p[1] === '\\') return null;
  if (/[\\\u0000-\u001f\u007f]/.test(p)) return null;
  if (/^\/admin(\/|$|\?|#)/.test(p)) return null;
  return p;
}

const push = () => appPlugins().PushNotifications;
const asked = (): boolean => {
  const v = store.get(ASKED_KEY);
  if (!v) return false;
  if (v === '1') return true;
  const t = Number(v);
  return Number.isFinite(t) && Date.now() - t < LATER_MS;
};

/** Pages where a sheet would get in the way (sign-in, verification steps, live call screens). */
const QUIET = /^\/(sign-in|sign-up|sign-out|forgot-password|hosts\/kyc|hosts\/onboarding|call)(\/|$)/;

function closeSheet(): void { sheet?.remove(); sheet = null; }

function showSheet(onAllow: () => void, onLater: () => void): void {
  if (sheet) return;
  const wrap = document.createElement('div');
  wrap.className = 'hf-exit-wrap hf-push-wrap';
  wrap.innerHTML =
    '<div class="hf-exit-sheet hf-push-sheet" role="dialog" aria-modal="true" aria-labelledby="hf-push-title">' +
    '<h2 id="hf-push-title"></h2><p></p>' +
    '<div class="hf-exit-actions"><button type="button" class="hf-exit-yes hf-push-later">Not now</button><button type="button" class="hf-exit-stay hf-push-allow">Allow</button></div>' +
    '</div>';
  wrap.querySelector('#hf-push-title')!.textContent = 'Know when your favourite host comes online';
  wrap.querySelector('p')!.textContent = 'Turn on notifications and we will tell you when a host you follow is online. We only send things that matter to you.';
  wrap.querySelector('.hf-push-allow')!.addEventListener('click', () => { closeSheet(); onAllow(); });
  wrap.querySelector('.hf-push-later')!.addEventListener('click', () => { closeSheet(); onLater(); });
  document.body.appendChild(wrap);
  sheet = wrap;
  (wrap.querySelector('.hf-push-allow') as HTMLElement).focus();
}

async function sendToken(token: string): Promise<void> {
  const shell = (navigator.userAgent.match(/HelloFraandsApp\/(\d+)/) || [])[1] || '';
  const r = await hfCall('POST', '/api/hf/push/register', { token, platform: 'android', shell });
  if (r.ok) {
    store.set(TOKEN_KEY, token);
    capture('hf_push_registered', { shell_version: Number(shell) || 0 });
  } else if (r.status !== 401) {
    captureException(new Error(`push register ${r.status} ${r.code}`), { where: 'hf_push_register' });
  }
}

/** Create the notification channel, then ask FCM for a token. The 'registration' listener sends it to the worker. */
async function register(): Promise<void> {
  const p = push();
  if (!p?.register || registering) return;
  registering = true;
  try {
    try { await p.createChannel?.({ id: PUSH_CHANNEL_ID, name: 'Updates', description: 'Hosts coming online, your profile, payments and reviews', importance: 4, visibility: 1 }); } catch { /* older plugin: the manifest default channel is used */ }
    await p.register();
  } catch (err) {
    captureException(err, { where: 'hf_push_register' });
  } finally {
    registering = false;
  }
}

async function allowFlow(): Promise<void> {
  const p = push();
  store.set(ASKED_KEY, '1');
  if (!p?.requestPermissions) return;
  try {
    const r = await p.requestPermissions();
    const granted = r?.receive === 'granted';
    capture('hf_app_permission', { kind: 'push', result: granted ? 'granted' : 'denied' });
    if (granted) await register();
  } catch (err) {
    captureException(err, { where: 'hf_push_permission' });
  }
}

async function maybeStart(): Promise<void> {
  const p = push();
  if (!p?.checkPermissions || looksSignedOut()) return;
  if (QUIET.test(location.pathname)) return;
  try {
    const cur = await p.checkPermissions();
    if (cur?.receive === 'granted') { await register(); return; } // already allowed: refresh the token quietly
    if (cur?.receive === 'denied' || asked()) return;
    showSheet(() => { void allowFlow(); }, () => {
      store.set(ASKED_KEY, String(Date.now()));
      capture('hf_app_permission', { kind: 'push', result: 'dismissed' });
    });
  } catch (err) {
    captureException(err, { where: 'hf_push_permission' });
  }
}

/** Remove this phone's token for the signed-in person (called from the sign-out page before Clerk ends the session). Never throws. */
export async function unregisterPush(): Promise<void> {
  if (!isAppMode()) return;
  const token = store.get(TOKEN_KEY);
  if (!token) return;
  try {
    await Promise.race([hfCall('DELETE', '/api/hf/push/register', { token }), new Promise((r) => setTimeout(r, 4000))]);
  } catch { /* best effort: the worker also drops dead tokens and re-owns a token on the next sign-in */ }
  store.del(TOKEN_KEY);
}

/** Wire the listeners once and offer the sheet when the person is signed in. Does nothing outside the app. */
export function initAppPush(): void {
  if (started || typeof window === 'undefined' || !isAppMode()) return;
  const p = push();
  if (!p?.addListener) return;
  started = true;
  try {
    void Promise.resolve(p.addListener('registration', (t: { value?: string }) => {
      if (t?.value) void sendToken(t.value).catch((err: unknown) => captureException(err, { where: 'hf_push_register' }));
    })).catch(() => {});
    void Promise.resolve(p.addListener('registrationError', (e: unknown) => captureException(new Error('push registration error: ' + JSON.stringify(e ?? {}).slice(0, 200)), { where: 'hf_push_registration_error' }))).catch(() => {});
    void Promise.resolve(p.addListener('pushNotificationActionPerformed', (a: { notification?: { data?: Record<string, unknown> } }) => {
      try {
        const d = a?.notification?.data ?? {};
        const path = samePath(d.path);
        capture('hf_push_opened', { kind: typeof d.kind === 'string' ? d.kind.slice(0, 30) : 'unknown' });
        if (path && path !== location.pathname + location.search) location.assign(path);
      } catch (err) {
        captureException(err, { where: 'hf_push_open' });
      }
    })).catch(() => {});
  } catch (err) {
    captureException(err, { where: 'hf_push_open' });
  }
  // The explainer waits a moment so it never lands on top of the page the person just opened.
  const go = () => window.setTimeout(() => { void maybeStart(); }, 2500);
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
  window.addEventListener('site:active-session-changed', () => { window.setTimeout(() => { void maybeStart(); }, 1500); });
}
