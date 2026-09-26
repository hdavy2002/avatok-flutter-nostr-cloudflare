// [DASH2-PUSH 2026-09-26] Browser side of Saa Thum web push.
// The service worker (public/sw.js) is registered by InstallPrompt.tsx; this module only
// asks permission, subscribes/unsubscribes via pushManager and tells the worker
// (/api/me/push/*, routes/me_push.ts). Telemetry: dash2_push_subscribe {ok, platform}.
import { capture, captureException } from '../../lib/analytics';
import { meApi } from './accountApi';

export type PushPlatform = 'ios' | 'android' | 'desktop';
export type PushSupport =
  | 'supported'
  /** iPhone/iPad Safari tab: web push exists only for a home-screen app. */
  | 'ios_needs_install'
  | 'unsupported';

export const IOS_INSTALL_HINT = 'Install Saa Thum to your home screen to get notifications';

function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch { return false; }
}
export function pushPlatform(): PushPlatform {
  if (typeof navigator === 'undefined') return 'desktop';
  if (isIos()) return 'ios';
  return /Android/i.test(navigator.userAgent) ? 'android' : 'desktop';
}

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (isIos() && !isStandalone()) return 'ios_needs_install';
  const ok = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  return ok ? 'supported' : 'unsupported';
}

export function permission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // InstallPrompt registers /sw.js on load; make sure a registration exists even if it has not yet.
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (!existing) await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

/** This device's current subscription (null when none or unsupported). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'supported') return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch { return null; }
}

export type EnableResult = { ok: true } | { ok: false; reason: 'unsupported' | 'ios_needs_install' | 'denied' | 'unavailable' | 'error'; message: string };

/** Ask permission, subscribe this device, register it with the worker. */
export async function enablePush(): Promise<EnableResult> {
  const platform = pushPlatform();
  const support = pushSupport();
  const fail = (reason: Exclude<EnableResult, { ok: true }>['reason'], message: string): EnableResult => {
    capture('dash2_push_subscribe', { ok: false, platform, reason });
    return { ok: false, reason, message };
  };
  if (support === 'ios_needs_install') return fail('ios_needs_install', IOS_INSTALL_HINT);
  if (support !== 'supported') return fail('unsupported', 'This browser can’t show notifications.');
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return fail('denied', 'Notifications are blocked. Allow them in your browser’s site settings, then try again.');
    const { enabled, public_key } = await meApi<{ enabled: boolean; public_key: string | null }>('/api/me/push/public-key');
    if (!enabled || !public_key) return fail('unavailable', 'Reminders aren’t available right now. Please try again later.');
    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();
    const want = urlBase64ToUint8Array(public_key);
    // A subscription made with an older server key can't receive our pushes: replace it.
    const have = sub?.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (sub && have && (have.length !== want.length || have.some((b, i) => b !== want[i]))) {
      await sub.unsubscribe().catch(() => undefined);
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want as BufferSource });
    const j = sub.toJSON();
    await meApi('/api/me/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: { p256dh: j.keys?.p256dh, auth: j.keys?.auth } } });
    capture('dash2_push_subscribe', { ok: true, platform });
    return { ok: true };
  } catch (e) {
    captureException(e, { where: 'dash2_push_subscribe' });
    return fail('error', 'We couldn’t turn on reminders. Please try again.');
  }
}

/** Unsubscribe this device and tell the worker. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => undefined);
  await meApi('/api/me/push/unsubscribe', { method: 'POST', body: { endpoint } });
  capture('dash2_push_unsubscribe', { platform: pushPlatform() });
}
