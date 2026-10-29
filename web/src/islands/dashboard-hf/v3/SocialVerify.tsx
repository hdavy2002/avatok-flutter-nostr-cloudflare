/* [HF-INTRO-B4] "Log in with Facebook" for Social media verification (Specs/HF-FACEBOOK-LOGIN-1.md). Shown only while hfFacebookLoginEnabled is on.
 * GET /api/hf/channels/facebook/start?client=web&return=<verifications|become> -> { url }; we go to that url. Facebook returns to that page with
 * ?fb=connected|error&reason=... (the worker's web redirect), which SocialReturnNote reads, shows and then removes from the address bar.
 * [HF-VERIFY-WEB-FLOW] Same for "Log in with Instagram" (?ig=..., flag hfInstagramLoginEnabled, Specs/HF-CHANNEL-LOGIN-1.md) and
 * "Connect YouTube with Google" (Google token popup -> POST /api/hf/channels/youtube/connect, the call the old wizard's channel step makes).
 * Facebook's "#_=_" is removed from the address bar on load. */
import { useEffect, useState } from 'react';
import { capture } from '../../../lib/analytics';
import { FB_ERROR_TEXT, IG_ERROR_TEXT, facebookStart, instagramStart, introFlags, stripFacebookHash, type IntroFlags, type WebReturn } from '../../../lib/hfIntroDash';
import { facebookConnectedText } from '../../../lib/hfSocialStates';
import { hfCall } from '../../../lib/hfCallsApi';

const track = (e: string, p: Record<string, unknown>) => { try { capture(e, p as never); } catch { /* telemetry must never break the page */ } };

export function useIntroFlags(): IntroFlags | null {
  const [f, setF] = useState<IntroFlags | null>(null);
  useEffect(() => { let l = true; void introFlags().then(x => { if (l) setF(x); }); return () => { l = false; }; }, []);
  return f;
}
export function useFacebookOn(): boolean {
  return !!useIntroFlags()?.facebook;
}

// Solid platform colours (no gradients). White text passes contrast on all three.
const FB_STYLE = { background: '#1877f2', color: '#fff', borderColor: '#1877f2' } as const;
const IG_STYLE = { background: '#c13584', color: '#fff', borderColor: '#c13584' } as const;
const YT_STYLE = { background: '#cc0000', color: '#fff', borderColor: '#cc0000' } as const;

type StartResult = { ok: true; data: { url: string } } | { ok: false; message?: string };
function OAuthButton({ platform, label, busyLabel, style, start, surface }: {
  platform: 'facebook' | 'instagram'; label: string; busyLabel: string; style: React.CSSProperties; surface: string; start: () => Promise<StartResult>;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const go = async () => {
    if (busy) return;
    setBusy(true); setMsg('');
    track('hf_social_verify_click', { platform, surface });
    const r = await start();
    if (r.ok && r.data.url) { window.location.assign(r.data.url); return; }
    setBusy(false);
    setMsg((!r.ok && r.message) || `We could not start ${platform === 'facebook' ? 'Facebook' : 'Instagram'} login. Please try again.`);
  };
  return <>
    <button type="button" className="h3-btn" onClick={() => void go()} disabled={busy} style={style}>{busy ? busyLabel : label}</button>
    {msg && <p className="small" style={{ color: 'var(--bad)', flexBasis: '100%' }} role="alert">{msg}</p>}
  </>;
}

/** connected = she already has a Facebook Page here, so the button reads "Log in with Facebook again". */
export function FacebookLoginButton({ surface, ret = 'become', connected = false }: { surface: string; ret?: WebReturn; connected?: boolean }) {
  const on = useFacebookOn();
  if (!on) return null;
  return <OAuthButton platform="facebook" surface={surface} style={FB_STYLE} label={connected ? 'Log in with Facebook again' : 'Log in with Facebook'} busyLabel="Opening Facebook…" start={() => facebookStart(ret)} />;
}

export function InstagramLoginButton({ surface, ret = 'become', connected = false }: { surface: string; ret?: WebReturn; connected?: boolean }) {
  const f = useIntroFlags();
  if (!f?.instagram) return null;
  return <OAuthButton platform="instagram" surface={surface} style={IG_STYLE} label={connected ? 'Log in with Instagram again' : 'Log in with Instagram'} busyLabel="Opening Instagram…" start={() => instagramStart(ret)} />;
}

// ── YouTube with Google: a token popup (no page redirect), so no return path is needed. Same call as the old wizard's ChannelStep. ──
const GOOGLE_CLIENT_ID: string | undefined = import.meta.env.PUBLIC_GOOGLE_CLIENT_ID || undefined;
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
interface GisTokenClient { requestAccessToken(): void }
interface GisWindow { google?: { accounts: { oauth2: { initTokenClient(c: { client_id: string; scope: string; callback: (r: { access_token?: string; error?: string }) => void; error_callback?: () => void }): GisTokenClient } } } }
function loadGoogle(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as unknown as GisWindow).google?.accounts) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => resolve(); s.onerror = () => reject(new Error('google'));
    document.head.appendChild(s);
  });
}
const YT_TEXT: Record<string, string> = {
  approved: 'Your YouTube channel is connected and counts for verification.',
  needs_followers: 'Your YouTube channel is connected, but it does not have enough subscribers yet to count.',
  needs_views: 'Your YouTube channel is connected, but it does not have enough total views yet to count.',
  hidden_count: 'Your YouTube channel is connected, but your subscriber count is hidden. Show it in YouTube settings so it can count.',
};

/** onDone gets the message to show and reloads the card. Hidden while hfChannelsEnabled is off or the site has no Google client id. */
export function YouTubeConnectButton({ surface, connected = false, onDone }: { surface: string; connected?: boolean; onDone: (note: { ok: boolean; text: string }) => void | Promise<void> }) {
  const f = useIntroFlags();
  const [busy, setBusy] = useState(false);
  if (!f?.channels || !GOOGLE_CLIENT_ID) return null;
  const go = async () => {
    if (busy) return;
    setBusy(true);
    track('hf_social_verify_click', { platform: 'youtube', surface });
    try {
      await loadGoogle();
      const token = await new Promise<string>((resolve, reject) => {
        (window as unknown as GisWindow).google!.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID, scope: YT_SCOPE,
          callback: r => (r.access_token ? resolve(r.access_token) : reject(new Error(r.error || 'denied'))),
          error_callback: () => reject(new Error('closed')),
        }).requestAccessToken();
      });
      const r = await hfCall<{ ok: boolean; result?: string; message?: string }>('POST', '/api/hf/channels/youtube/connect', { accessToken: token });
      if (r.ok) {
        const result = r.data.result || 'approved';
        track('hf_social_verify_return', { platform: 'youtube', result: 'connected', threshold: result });
        await onDone({ ok: result === 'approved', text: YT_TEXT[result] || r.data.message || YT_TEXT.approved });
      } else {
        track('hf_social_verify_return', { platform: 'youtube', result: 'error', reason: r.code || undefined });
        await onDone({ ok: false, text: r.message || 'We could not connect your YouTube channel. Please try again.' });
      }
    } catch {
      await onDone({ ok: false, text: 'Google sign-in did not finish. Please try again.' });
    }
    setBusy(false);
  };
  return <button type="button" className="h3-btn" onClick={() => void go()} disabled={busy} style={YT_STYLE}>{busy ? 'Please wait…' : connected ? 'Connect YouTube with Google again' : 'Connect YouTube with Google'}</button>;
}

/** Reads ?fb= / ?ig= (connected|error, &reason=, &result=) once, shows it, and cleans the address bar (also Facebook's "#_=_"). */
export function SocialReturnNote() {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    stripFacebookHash();
    try {
      const u = new URL(window.location.href);
      const fb = u.searchParams.get('fb'), ig = u.searchParams.get('ig');
      const v = fb ?? ig;
      if (!v) return;
      const platform = fb ? 'facebook' : 'instagram';
      const reason = u.searchParams.get('reason') || '', result = u.searchParams.get('result') || '';
      if (v === 'connected') {
        setNote(platform === 'facebook'
          ? { ok: result !== 'needs_followers', text: facebookConnectedText(result) } // [HF-SOCIAL-STATES] below the minimum is connected, not verified
          : result === 'needs_followers'
            ? { ok: false, text: 'Your Instagram account is connected, but it does not have enough followers yet to count. Add YouTube or Facebook, or do the Aadhaar check / video KYC.' }
            : { ok: true, text: 'Instagram is connected. Your social media verification is updated.' });
      } else {
        const table = platform === 'facebook' ? FB_ERROR_TEXT : IG_ERROR_TEXT;
        setNote({ ok: false, text: table[reason] || `${platform === 'facebook' ? 'Facebook' : 'Instagram'} login did not finish. Please try again.` });
      }
      track('hf_social_verify_return', { platform, result: v === 'connected' ? 'connected' : 'error', reason: reason || undefined });
      ['fb', 'ig', 'reason', 'result'].forEach(k => u.searchParams.delete(k));
      window.history.replaceState(null, '', u.pathname + (u.search || '') + (u.hash === '#_=_' ? '' : u.hash));
    } catch { /* no URL access: no note */ }
  }, []);
  return <SocialNote note={note} />;
}
/** Old name, still used by the Become page. */
export const FacebookReturnNote = SocialReturnNote;

export function SocialNote({ note }: { note: { ok: boolean; text: string } | null }) {
  if (!note) return null;
  return <aside className="h3-safe" role={note.ok ? 'status' : 'alert'} style={{ background: note.ok ? 'var(--teatint)' : 'var(--goldtint)' }}><div><p>{note.text}</p></div></aside>;
}
