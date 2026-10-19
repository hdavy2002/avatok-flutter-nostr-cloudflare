/* DemoInfluencers — [HF-WIRE-14] Paste YouTube links (one per line) + a name and a rate to create or fill a demo influencer.
 * Worker: GET/POST /api/admin/hf/demo-influencers, DELETE /api/admin/hf/demo-influencers/:uid. Videos are embeds only. Nothing under 14px. */
import { useCallback, useEffect, useState } from 'react';
import { hfAdminApi, type DemoInfluencer, type DemoSaveResult } from '../../../lib/hfAdminApi';
import { Banner, ConsultShell, Spinner, dateIST, fail, track } from '../consultants/kit';

const T14 = { fontSize: 14 } as const;
const inp = { minHeight: 40, padding: '8px 10px', borderRadius: 10, border: '1px solid #d9cbd6', background: '#fff', ...T14 } as const;

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
    try { setItems(await hfAdminApi.demoInfluencers()); } catch (e) { setError(fail('demo_list', e)); setItems([]); }
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
    <ConsultShell>
      {error && <Banner tone="error">{error}</Banner>}
      {info && <Banner tone="info">{info}</Banner>}
      <div className="card" style={{ padding: 14, background: '#fff', marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 18 }}>Create or fill a demo influencer</h3>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={T14}>Add to<br />
            <select value={fillUid} onChange={(e) => setFillUid(e.target.value)} style={{ ...inp, minWidth: 180 }} aria-label="Add to">
              <option value="">A new demo influencer</option>
              {(items ?? []).map((d) => <option key={d.uid} value={d.uid}>{d.name || d.uid}</option>)}
            </select>
          </label>
          <label style={T14}>Display name<br /><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} style={{ ...inp, width: 200 }} aria-label="Display name" /></label>
          <label style={T14}>Rate (rupees per minute)<br /><input type="number" min={1} max={1000} value={rupees} onChange={(e) => setRupees(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} style={{ ...inp, width: 120 }} aria-label="Rate" /></label>
        </div>
        <label style={{ ...T14, display: 'block', marginTop: 12 }}>YouTube video links, one per line<br />
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={'https://www.youtube.com/watch?v=...\nhttps://youtu.be/...\nhttps://www.youtube.com/shorts/...'} style={{ ...inp, width: '100%', maxWidth: 640, fontFamily: 'inherit' }} aria-label="YouTube links" />
        </label>
        <p className="muted" style={{ ...T14, margin: '6px 0 10px' }}>{urls.length} link{urls.length === 1 ? '' : 's'}. Videos stay on YouTube and play in the official player. A demo profile never takes calls or payments.</p>
        <button type="button" className="btn" style={T14} disabled={busy === 'save' || !urls.length || (!fillUid && !name.trim())} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : fillUid ? 'Add videos' : 'Create demo influencer'}</button>
      </div>

      {items === null ? <Spinner label="Loading demo influencers" /> : items.length === 0 ? <p className="muted" style={T14}>No demo influencers yet.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', ...T14, minWidth: 520 }}>
            <thead><tr>{['Name', 'Rate', 'Videos', 'Made', ''].map((h) => <th key={h} style={{ textAlign: 'left', padding: '6px 10px' }}>{h}</th>)}</tr></thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.uid}>
                  <td style={{ padding: '6px 10px' }}>{d.name || d.uid}{d.slug ? <span className="muted"> · {d.slug}</span> : null}</td>
                  <td style={{ padding: '6px 10px' }}>₹{Math.round(d.ratePaise / 100)}/min</td>
                  <td style={{ padding: '6px 10px' }}>{d.videos}</td>
                  <td style={{ padding: '6px 10px' }}>{dateIST(d.createdAt)}</td>
                  <td style={{ padding: '6px 10px' }}><button type="button" className="btn ghost" style={T14} disabled={busy === d.uid} onClick={() => void remove(d)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ConsultShell>
  );
}
