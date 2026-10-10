/* [HF-APP-5] Camera and microphone inside the Android app (Capacitor WebView).
 * App mode only: on the plain website every helper here is a no-op, so today's behaviour is unchanged.
 * The Android runtime prompt itself is raised by Capacitor's BridgeWebChromeClient when getUserMedia is called;
 * these helpers add the explainer decision, the "Open settings" path and the hf_app_permission telemetry. */
import { isAppMode } from './nativeBridge';
import { capture } from './analytics';

export type PermKind = 'camera' | 'mic';
export type PermResult = 'granted' | 'denied' | 'error';

interface HfSettingsPlugin { openAppSettings?: () => unknown }

/** True when getUserMedia was refused by the person or by Android (NotAllowedError / SecurityError). */
export function isPermissionDenied(e: unknown): boolean {
  const n = (e as { name?: string } | null)?.name;
  return n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError';
}

/** hf_app_permission {kind, result}. App mode only; never throws. */
export function trackPermission(kind: PermKind, result: PermResult): void {
  try { if (isAppMode()) capture('hf_app_permission', { kind, result }); } catch { /* telemetry must never break the recorder */ }
}

/** Should the "why we need it" screen show before getUserMedia? App mode only, and not when the browser already says granted. */
export async function needsExplainer(kind: PermKind): Promise<boolean> {
  if (!isAppMode()) return false;
  try {
    const q = await navigator.permissions?.query({ name: (kind === 'camera' ? 'camera' : 'microphone') as PermissionName });
    if (q && q.state === 'granted') return false;
  } catch { /* the Permissions API does not know camera/microphone here: show the explainer */ }
  return true;
}

/** Opens this app's Android settings page (native HfSettings plugin). Returns false when the plugin is missing (older shell), so the caller can show instructions. */
export function openAppSettings(): boolean {
  try {
    const p = (window as unknown as { Capacitor?: { Plugins?: { HfSettings?: HfSettingsPlugin } } }).Capacitor?.Plugins?.HfSettings;
    if (!p?.openAppSettings) return false;
    void Promise.resolve(p.openAppSettings()).catch(() => {});
    return true;
  } catch { return false; }
}

/** First supported recording type from a preference list (MediaRecorder.isTypeSupported); undefined lets the browser choose. */
export function pickRecorderMime(choices: string[]): string | undefined {
  try {
    const MR = (window as unknown as { MediaRecorder?: { isTypeSupported?: (m: string) => boolean } }).MediaRecorder;
    return choices.find(m => MR?.isTypeSupported?.(m));
  } catch { return undefined; }
}

/** Selfie video: the worker accepts video/webm, video/mp4, video/quicktime. Android WebView normally gives webm (vp8/vp9 + opus). */
export const VIDEO_MIME_CHOICES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
