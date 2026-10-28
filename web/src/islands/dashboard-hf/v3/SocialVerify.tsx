/* [HF-INTRO-B4] "Log in with Facebook" for Social media verification (Specs/HF-FACEBOOK-LOGIN-1.md). Shown only while hfFacebookLoginEnabled is on.
 * GET /api/hf/channels/facebook/start?client=web -> { url }; we go to that url. Facebook returns to /dashboard/become?fb=connected|error&reason=...
 * (the worker's web redirect), which FacebookReturnNote reads, shows and then removes from the address bar. */
import { useEffect, useState } from 'react';
import { capture } from '../../../lib/analytics';
import { FB_ERROR_TEXT, facebookStart, introFlags } from '../../../lib/hfIntroDash';

const track = (e: string, p: Record<string, unknown>) => { try { capture(e, p as never); } catch { /* telemetry must never break the page */ } };

export function useFacebookOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => { let l = true; void introFlags().then(f => { if (l) setOn(f.facebook); }); return () => { l = false; }; }, []);
  return on;
}

export function FacebookLoginButton({ surface }: { surface: string }) {
  const on = useFacebookOn();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  if (!on) return null;
  const go = async () => {
    if (busy) return;
    setBusy(true); setMsg('');
    track('hf_social_verify_click', { platform: 'facebook', surface });
    const r = await facebookStart();
    if (r.ok && r.data.url) { window.location.assign(r.data.url); return; }
    setBusy(false);
    setMsg((!r.ok && r.message) || 'We could not start Facebook login. Please try again.');
  };
  return <>
    <button type="button" className="h3-btn" onClick={() => void go()} disabled={busy} style={{ background: '#1877f2', color: '#fff', borderColor: '#1877f2' }}>{busy ? 'Opening Facebook…' : 'Log in with Facebook'}</button>
    {msg && <p className="small" style={{ color: 'var(--bad)', flexBasis: '100%' }} role="alert">{msg}</p>}
  </>;
}

/** Reads ?fb=connected|error (&reason=, &result=) once, shows it, and cleans the address bar. */
export function FacebookReturnNote() {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      const fb = u.searchParams.get('fb');
      if (!fb) return;
      const reason = u.searchParams.get('reason') || '', result = u.searchParams.get('result') || '';
      if (fb === 'connected') {
        setNote({ ok: true, text: result === 'needs_followers' ? 'Facebook is connected. It does not have enough followers yet to count as verified.' : 'Facebook is connected. Your social media verification is updated.' });
      } else setNote({ ok: false, text: FB_ERROR_TEXT[reason] || 'Facebook login did not finish. Please try again.' });
      track('hf_social_verify_return', { platform: 'facebook', result: fb === 'connected' ? 'connected' : 'error', reason: reason || undefined });
      ['fb', 'reason', 'result'].forEach(k => u.searchParams.delete(k));
      window.history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    } catch { /* no URL access: no note */ }
  }, []);
  if (!note) return null;
  return <aside className="h3-safe" role={note.ok ? 'status' : 'alert'} style={{ background: note.ok ? 'var(--teatint)' : 'var(--goldtint)' }}><div><p>{note.text}</p></div></aside>;
}
