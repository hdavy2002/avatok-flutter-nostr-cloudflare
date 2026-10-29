/* [HF-CREATOR-SPACES-1] Channel creators connect YouTube (Google sign-in proves ownership) or Instagram (a code in the bio).
 * The bar comes from the worker (minFollowers / minViews) and Continue opens only when GET /api/hf/channels says qualified.
 * Worker contract: worker/src/routes/hf_channels.ts. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { capture } from '../../../lib/analytics';
import Icon from '../Icon';
import type { ChannelAction, ChannelItem, ChannelsInfo, StepProps } from '../types';
import { accountName, platformName } from '../../../lib/hfSocialStates'; // [HF-SOCIAL-STATES]

const GOOGLE_CLIENT_ID: string | undefined = import.meta.env.PUBLIC_GOOGLE_CLIENT_ID || undefined;
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const fmt = (n: number) => n.toLocaleString('en-IN');

const MESSAGES: Record<string, string> = {
  approved: 'Your channel is connected.',
  needs_followers: 'We need a few more followers before your channel can go live.',
  code_missing: 'We could not see the code yet. It can take a minute to show. Check it is saved, then try again.',
  not_found: 'We could not find that channel. Please check the name or link.',
  private: 'That channel looks private. Please make it public and try again.',
  hidden_count: 'Your follower count is hidden. Please show it on your channel and try again.',
  claimed: 'This channel is already connected to another account.',
};

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

function stateLine(c: ChannelItem, info: ChannelsInfo): { text: string; ok: boolean } {
  if (c.state === 'approved') return { text: 'Meets the bar', ok: true };
  if (c.needsCode) return { text: 'Waiting for your code', ok: false };
  // [HF-SOCIAL-STATES] proven but below the minimum: connected, does not count yet
  if (c.state === 'needs_views') return { text: `${c.verified ? 'Connected · ' : ''}needs ${fmt(info.minViews)} total views to count`, ok: false };
  if (c.state === 'needs_followers') return { text: `${c.verified ? 'Connected · ' : ''}needs ${fmt(info.minFollowers)} followers to count`, ok: false };
  return { text: 'Checking…', ok: false };
}

export default function ChannelStep({ draft, update, api, setAction }: StepProps) {
  const [info, setInfo] = useState<ChannelsInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState<'youtube' | 'instagram'>('youtube');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const apply = useCallback((next: ChannelsInfo | null | undefined) => {
    if (!next) return;
    setInfo(next);
    update({ channelQualified: next.qualified });
  }, [update]);

  useEffect(() => {
    let ok = true;
    void api.listChannels().then(r => { if (ok) { apply(r); setLoading(false); } });
    return () => { ok = false; };
  }, [api, apply]);

  const report = (r: ChannelAction) => {
    if (!live.current) return;
    if (!r.ok) { setMsg({ text: r.error || 'Something went wrong. Please try again.', ok: false }); return; }
    apply(r.info);
    const ch = r.channel;
    const result = r.result || (ch?.state === 'approved' ? 'approved' : 'needs_followers');
    setMsg({ text: r.message || MESSAGES[result] || '', ok: result === 'approved' });
    if (result === 'approved') { try { capture('hf_verify_badge_added', { badge: 'channel' } as never); } catch { /* ignore */ } }
    try { capture('hf_channel_threshold', { result, followers: ch?.followers ?? 0, views: ch?.views ?? 0 } as never); } catch { /* ignore */ }
  };

  const add = async () => {
    setBusy('add'); setMsg(null);
    const r = await api.addChannel(platform, handle);
    if (r.ok) setHandle('');
    report(r);
    setBusy(null);
  };
  const check = async (id: string) => { setBusy(id); setMsg(null); report(await api.checkChannel(id)); setBusy(null); };
  const remove = async (id: string) => {
    setBusy(id); setMsg(null);
    const r = await api.removeChannel(id);
    if (r.ok) apply(await api.listChannels()); else setMsg({ text: r.error || 'We could not remove it.', ok: false });
    setBusy(null);
  };
  const google = async () => {
    setBusy('google'); setMsg(null);
    try {
      if (!GOOGLE_CLIENT_ID) throw new Error('no_client');
      await loadGoogle();
      const token = await new Promise<string>((resolve, reject) => {
        const g = (window as unknown as GisWindow).google!;
        g.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID, scope: YT_SCOPE,
          callback: r => (r.access_token ? resolve(r.access_token) : reject(new Error(r.error || 'denied'))),
          error_callback: () => reject(new Error('closed')),
        }).requestAccessToken();
      });
      report(await api.connectYoutube(token));
    } catch {
      if (live.current) setMsg({ text: 'We could not sign you in with Google. You can also add your channel name below and use a code instead.', ok: false });
    }
    if (live.current) setBusy(null);
  };

  const qualified = !!info?.qualified || draft.channelQualified;
  useEffect(() => {
    setAction({ label: 'Continue', disabled: !qualified, run: () => true });
  }, [qualified, setAction]);

  const channels = (info?.channels ?? []).filter(c => c.state !== 'disconnected');
  return (
    <div>
      <h1 className="hob-h1">Connect your channel</h1>
      <p className="hob-lead">Connect a channel you own. We read the public numbers only, and we never post anything.</p>

      <div className="hob-card hob-s-bar">
        <span className="hob-v-ico" aria-hidden="true"><Icon name="star" /></span>
        <p className="hob-v-strong">
          {info ? <>At least {fmt(info.minFollowers)} followers and {fmt(info.minViews)} views (YouTube)</> : 'Checking the bar…'}
          <span className="hob-help hob-s-block">Instagram is checked on followers only.</span>
        </p>
      </div>

      {loading && <p className="hob-loading" role="status">Loading…</p>}

      {channels.length > 0 && (
        <ul className="hob-s-list" aria-label="Your channels">
          {channels.map(c => {
            const st = info ? stateLine(c, info) : { text: '', ok: false };
            return (
              <li key={c.id} className="hob-card hob-s-ch">
                <div className="hob-s-ch-head">
                  <div>
                    <p className="hob-v-strong">{platformName(c.platform)} · {accountName({ platform: c.platform, handle: c.handle, displayHandle: c.displayHandle ?? null })}</p>
                    <p className="hob-help">{fmt(c.followers)} followers{c.platform === 'youtube' ? ` · ${fmt(c.views)} views` : ''}</p>
                  </div>
                  <span className={`hob-s-pill${st.ok ? ' is-ok' : ''}`}>{st.text}</span>
                </div>
                {c.needsCode && c.verifyCode && (
                  <div className="hob-s-code">
                    <p className="hob-help">Put this code in your {c.platform === 'youtube' ? 'channel description (About)' : 'Instagram bio'}, save it, then tap Check.</p>
                    <p className="hob-s-codebox" aria-label="Your code">{c.verifyCode}</p>
                  </div>
                )}
                <div className="hob-s-acts">
                  {c.state !== 'approved' && c.platform !== 'facebook' && ( /* [HF-SOCIAL-STATES] a Facebook Page refreshes by logging in again */
                    <button type="button" className="hob-btn hob-btn-primary" disabled={busy !== null} onClick={() => void check(c.id)}>{busy === c.id ? 'Checking…' : 'Check'}</button>
                  )}
                  <button type="button" className="hob-btn hob-btn-ghost" disabled={busy !== null} onClick={() => void remove(c.id)}>Remove</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {msg && <p className={msg.ok ? 'hob-help hob-s-okmsg' : 'hob-error'} role="alert" aria-live="polite">{msg.text}</p>}

      <section className="hob-card hob-s-add" aria-labelledby="hob-s-add-h">
        <h2 id="hob-s-add-h" className="hob-v-h2">Add a channel</h2>
        {GOOGLE_CLIENT_ID && (
          <button type="button" className="hob-btn hob-btn-primary hob-v-start" disabled={busy !== null} onClick={() => void google()}>
            {busy === 'google' ? 'Please wait…' : 'Connect YouTube with Google'}
          </button>
        )}
        <div className="hob-v-chips" role="group" aria-label="Platform">
          {(['youtube', 'instagram'] as const).map(p => (
            <button key={p} type="button" className="hob-chip" aria-pressed={platform === p} onClick={() => setPlatform(p)}>{p === 'youtube' ? 'YouTube' : 'Instagram'}</button>
          ))}
        </div>
        <div className="hob-field">
          <label className="hob-label" htmlFor="hob-s-handle">{platform === 'youtube' ? 'YouTube channel name or link' : 'Instagram username'}</label>
          <input id="hob-s-handle" className="hob-input" type="text" autoComplete="off" autoCapitalize="none" placeholder={platform === 'youtube' ? '@yourchannel' : '@yourname'} value={handle} onChange={e => setHandle(e.target.value)} />
          <p className="hob-help">We will show you a short code to put in your {platform === 'youtube' ? 'channel description' : 'bio'}, so we know it is yours.</p>
        </div>
        <button type="button" className="hob-btn hob-btn-ghost hob-v-start" disabled={busy !== null || handle.trim().length < 2} onClick={() => void add()}>{busy === 'add' ? 'Adding…' : 'Add channel'}</button>
      </section>
    </div>
  );
}
