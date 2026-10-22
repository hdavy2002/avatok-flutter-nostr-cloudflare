/* DemoInfluencers — [HF-WIRE-14] Paste YouTube links (one per line) + a name and a rate to create or fill a demo influencer.
 * Worker: GET/POST /api/admin/hf/demo-influencers, DELETE /api/admin/hf/demo-influencers/:uid. Videos are embeds only. Nothing under 14px. */
import { useCallback, useEffect, useState } from 'react';
import { hfAdminApi, type DemoInfluencer, type DemoSaveResult, type InviteCreator } from '../../../lib/hfAdminApi';
import { dateIST, fail, track } from '../consultants/kit';
import { DesiAvatar, DesiCard, DesiChip, DesiEmpty, DesiPersonCard } from '../desi';
import { HBanner } from './hostsKit';

export function linesOf(text: string): string[] {
  return text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

export function summaryOf(r: DemoSaveResult): string {
  const parts = [`${r.added} video${r.added === 1 ? '' : 's'} added`];
  if (r.skipped) parts.push(`${r.skipped} already there`);
  if (r.missing.length) parts.push(`${r.missing.length} private or not found`);
  if (r.bad.length) parts.push(`${r.bad.length} not a YouTube link`);
  return `${r.name}: ${parts.join(', ')}.`;
}

/** [HF-WIRE-22] Invite creators: add by platform + handle, hide / show. Their reels follow the network reels in the feed with an Invite button. */
export function InviteCreators() {
  const [items, setItems] = useState<InviteCreator[] | null>(null);
  const [platform, setPlatform] = useState<'youtube' | 'instagram'>('youtube');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setItems(await hfAdminApi.inviteCreators(setItems)); } catch (e) { setError(fail('invite_list', e)); setItems([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const add = async () => {
    setBusy('add'); setError(null); setInfo(null);
    try {
      const r = await hfAdminApi.addInviteCreator({ platform, handle: handle.trim() });
      track('invite_add', { ok: true, reels: r.reels });
      setInfo(`${r.creator.handle} added with ${r.reels} reel${r.reels === 1 ? '' : 's'}.`); setHandle('');
      await load();
    } catch (e) { setError(fail('invite_add', e)); } finally { setBusy(null); }
  };
  const toggle = async (c: InviteCreator) => {
    setBusy(c.platform + c.handle); setError(null); setInfo(null);
    try { await hfAdminApi.hideInviteCreator(c.platform, c.handle, !c.hidden); await load(); }
    catch (e) { setError(fail('invite_hide', e)); } finally { setBusy(null); }
  };
  return (
    <DesiCard tone="lav" corner="hibiscus" title="Invite creators (not on the app yet)" note="Their latest reels show after the network reels in the feed, with an Invite button. Fans' searches and Invite votes add creators here too.">
      <div className="hfa-stack">
        {error && <HBanner tone="error">{error}</HBanner>}
        {info && <HBanner tone="info">{info}</HBanner>}
        <div className="hfh-fields">
          <label className="hfh-field">Platform
            <select value={platform} onChange={(e) => setPlatform(e.target.value as 'youtube' | 'instagram')} aria-label="Platform">
              <option value="youtube">YouTube</option>
              <option value="instagram">Instagram</option>
            </select>
          </label>
          <label className="hfh-field">Handle<input value={handle} onChange={(e) => setHandle(e.target.value)} maxLength={120} placeholder="@name" aria-label="Handle" /></label>
          <div><button type="button" className="hfa-btn" disabled={busy === 'add' || handle.trim().length < 2} onClick={() => void add()}>{busy === 'add' ? 'Adding…' : 'Add creator'}</button></div>
        </div>
        {items === null ? <p role="status" className="hfa-note">Loading invite creators</p> : items.length === 0 ? <DesiEmpty text="No invite creators yet." /> : (
          <div className="hfh-demos">
            {items.map((c) => (
              <div key={c.platform + c.handle} className="hfh-demo" style={c.hidden ? { opacity: 0.6 } : undefined}>
                <DesiPersonCard band={c.platform === 'youtube' ? 'rani' : 'lav'} avatar={<DesiAvatar name={c.name || c.handle} seed={c.handle} size={60} />}
                  title={<>{c.handle}{c.name ? <span className="hfa-note"> · {c.name}</span> : null}</>}
                  sub={c.platform === 'youtube' ? 'YouTube' : 'Instagram'}
                  chips={<>{c.hidden && <DesiChip tone="grey">Hidden</DesiChip>}<DesiChip tone="lav">{c.followers.toLocaleString('en-IN')} followers</DesiChip></>}
                  meta={<><span>Votes {c.votes}</span><span>Reels {c.reels}</span><span>From {c.source}</span></>}>
                  <button type="button" className="hfa-btn ghost" disabled={busy === c.platform + c.handle} onClick={() => void toggle(c)}>{c.hidden ? 'Show' : 'Hide'}</button>
                </DesiPersonCard>
              </div>
            ))}
          </div>
        )}
      </div>
    </DesiCard>
  );
}

export default function DemoInfluencers() {
  const [items, setItems] = useState<DemoInfluencer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [rupees, setRupees] = useState(12);
  const [text, setText] = useState('');
  const [fillUid, setFillUid] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setItems(await hfAdminApi.demoInfluencers(setItems)); } catch (e) { setError(fail('demo_list', e)); setItems([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const urls = linesOf(text);
  const save = async () => {
    setBusy('save'); setError(null); setInfo(null);
    try {
      const r = await hfAdminApi.saveDemoInfluencer({ uid: fillUid || undefined, name: name.trim(), ratePaise: Math.round(rupees * 100), youtubeUrls: urls });
      track('demo_save', { ok: true, added: r.result.added });
      setInfo(summaryOf(r.result)); setText('');
      await load();
    } catch (e) { setError(fail('demo_save', e)); } finally { setBusy(null); }
  };
  const remove = async (d: DemoInfluencer) => {
    if (!window.confirm(`Delete ${d.name || 'this demo influencer'} and all their videos for good?`)) return;
    setBusy(d.uid); setError(null); setInfo(null);
    try { await hfAdminApi.deleteDemoInfluencer(d.uid); track('demo_delete', { ok: true }); await load(); }
    catch (e) { setError(fail('demo_delete', e)); } finally { setBusy(null); }
  };

  return (
    <div className="hfa-stack">
      <InviteCreators />
      {error && <HBanner tone="error">{error}</HBanner>}
      {info && <HBanner tone="info">{info}</HBanner>}
      <DesiCard tone="rani" corner="marigold" pattern="dots" title="Create or fill a demo influencer" note="Paste YouTube links, one per line.">
        <div className="hfa-stack">
          <div className="hfh-fields">
            <label className="hfh-field">Add to
              <select value={fillUid} onChange={(e) => setFillUid(e.target.value)} aria-label="Add to">
                <option value="">A new demo influencer</option>
                {(items ?? []).map((d) => <option key={d.uid} value={d.uid}>{d.name || d.uid}</option>)}
              </select>
            </label>
            <label className="hfh-field">Display name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Display name" /></label>
            <label className="hfh-field">Rate (rupees per minute)<input type="number" min={1} max={1000} value={rupees} onChange={(e) => setRupees(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} aria-label="Rate" /></label>
          </div>
          <label className="hfh-field">YouTube video links, one per line
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={'https://www.youtube.com/watch?v=...\nhttps://youtu.be/...\nhttps://www.youtube.com/shorts/...'} aria-label="YouTube links" />
          </label>
          <p className="hfa-note" style={{ margin: 0 }}>{urls.length} link{urls.length === 1 ? '' : 's'}. Videos stay on YouTube and play in the official player. A demo profile never takes calls or payments.</p>
          <div><button type="button" className="hfa-btn rani" disabled={busy === 'save' || !urls.length || (!fillUid && !name.trim())} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : fillUid ? 'Add videos' : 'Create demo influencer'}</button></div>
        </div>
      </DesiCard>

      {items === null ? <DesiCard tone="cream" pattern="dots"><p role="status" className="hfa-note">Loading demo influencers</p></DesiCard> : items.length === 0 ? <DesiCard tone="gold" corner="marigold"><DesiEmpty text="No demo influencers yet." /></DesiCard> : (
        <div className="hfh-demos">
          {items.map((d) => (
            <div key={d.uid} className="hfh-demo">
              <span className="hfh-demo-tag"><DesiChip tone="gold">Demo</DesiChip></span>
              <DesiPersonCard band="gold" avatar={<DesiAvatar name={d.name} seed={d.uid} size={72} />}
                title={d.name || d.uid} sub={d.slug || undefined}
                meta={<><span>₹{Math.round(d.ratePaise / 100)}/min</span><span>{d.videos} video{d.videos === 1 ? '' : 's'}</span><span>Made {dateIST(d.createdAt)}</span></>}>
                <span className="hfh-acts" style={{ marginTop: 6 }}>
                  <button type="button" className="hfh-chipbtn" disabled={busy === d.uid} onClick={() => void remove(d)} aria-label={`Delete ${d.name || d.uid}`}>Delete</button>
                </span>
              </DesiPersonCard>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
