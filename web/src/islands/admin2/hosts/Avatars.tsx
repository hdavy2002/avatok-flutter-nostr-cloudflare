/* Avatars — [HF-HOST-PLATFORM-1] Avatar library: filters, generate a batch, retire.
 * Worker: GET /api/admin/hf/avatars, POST /generate, POST /:id/retire. No green; nothing under 14px. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { hfAdminApi, type AdminAvatar, type AvatarJob } from '../../../lib/hfAdminApi';
import { Banner, ConsultShell, Spinner, dateIST, fail, track } from '../consultants/kit';

const GENDERS = ['woman', 'man'], AGES = ['20s', '30s', '40s', '50s+'], LOOKS = ['traditional', 'casual', 'office'];
const T14 = { fontSize: 14 } as const;
const sel = { minHeight: 40, padding: '0 10px', borderRadius: 10, border: '1px solid #d9cbd6', background: '#fff', ...T14 } as const;

export default function Avatars() {
  const [items, setItems] = useState<AdminAvatar[] | null>(null);
  const [jobs, setJobs] = useState<AvatarJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [f, setF] = useState({ gender: '', age: '', look: '', state: 'active' });
  const [g, setG] = useState({ count: 6, gender: 'woman', age: '30s', look: 'traditional' });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { const r = await hfAdminApi.avatars(); setItems(r.items ?? []); setJobs(r.jobs ?? []); } catch (e) { setError(fail('avatars_list', e)); setItems([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => (items ?? []).filter((a) =>
    (!f.gender || a.gender === f.gender) && (!f.age || a.age === f.age) && (!f.look || a.look === f.look) && (!f.state || a.status === f.state)), [items, f]);

  const generate = async () => {
    setBusy('gen'); setError(null); setInfo(null);
    try { await hfAdminApi.generateAvatars(g); track('avatars_generate', { ok: true }); setInfo('Batch started. New pictures appear here in a few minutes. Press Refresh.'); await load(); }
    catch (e) { setError(fail('avatars_generate', e)); } finally { setBusy(null); }
  };
  const retire = async (a: AdminAvatar) => {
    setBusy(a.id); setError(null);
    try { await hfAdminApi.retireAvatar(a.id); track('avatar_retire', { ok: true }); await load(); }
    catch (e) { setError(fail('avatar_retire', e)); } finally { setBusy(null); }
  };

  return (
    <ConsultShell>
      <div className="card" style={{ padding: 14, background: '#fff', marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 18 }}>Make a new batch</h3>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={T14}>How many (up to 12)<br /><input type="number" min={1} max={12} value={g.count} onChange={(e) => setG({ ...g, count: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })} style={{ ...sel, width: 100 }} /></label>
          <label style={T14}>Gender<br /><select value={g.gender} onChange={(e) => setG({ ...g, gender: e.target.value })} style={sel}>{GENDERS.map((x) => <option key={x}>{x}</option>)}</select></label>
          <label style={T14}>Age<br /><select value={g.age} onChange={(e) => setG({ ...g, age: e.target.value })} style={sel}>{AGES.map((x) => <option key={x}>{x}</option>)}</select></label>
          <label style={T14}>Look<br /><select value={g.look} onChange={(e) => setG({ ...g, look: e.target.value })} style={sel}>{LOOKS.map((x) => <option key={x}>{x}</option>)}</select></label>
          <button type="button" className="btn" style={T14} disabled={busy === 'gen'} onClick={() => void generate()}>{busy === 'gen' ? 'Starting…' : 'Generate batch'}</button>
        </div>
        {jobs.length > 0 && <p className="muted" style={{ ...T14, margin: '10px 0 0' }}>Recent batches: {jobs.map((j) => `${j.status}${j.error ? ` (${j.error})` : ''} · ${dateIST(j.created_at)}`).join('  |  ')}</p>}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
        <label style={T14}>Gender<br /><select value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })} style={sel}><option value="">All</option>{GENDERS.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label style={T14}>Age<br /><select value={f.age} onChange={(e) => setF({ ...f, age: e.target.value })} style={sel}><option value="">All</option>{AGES.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label style={T14}>Look<br /><select value={f.look} onChange={(e) => setF({ ...f, look: e.target.value })} style={sel}><option value="">All</option>{LOOKS.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label style={T14}>Show<br /><select value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} style={sel}><option value="active">Active</option><option value="retired">Retired</option><option value="">Both</option></select></label>
        <button type="button" className="btn small ghost" style={T14} onClick={() => void load()}>Refresh</button>
      </div>

      {error && <div style={{ marginBottom: 12 }}><Banner tone="error">{error}</Banner></div>}
      {info && <div style={{ marginBottom: 12 }}><Banner tone="info">{info}</Banner></div>}
      {items === null && <Spinner label="Loading avatars…" />}
      {items && shown.length === 0 && !error && <div className="card muted" style={{ fontWeight: 700, ...T14 }}>No avatars match.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
        {shown.map((a) => (
          <figure key={a.id} className="card" style={{ margin: 0, padding: 8, background: '#fff', opacity: a.status === 'retired' ? 0.6 : 1 }}>
            <img src={a.url} alt={`${a.gender}, ${a.age}, ${a.look}`} loading="lazy" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 10 }} />
            <figcaption style={{ ...T14, marginTop: 6 }}>
              {a.gender} · {a.age} · {a.look}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
                {a.taken && <span className="chip gold">Taken</span>}
                {a.status === 'retired' ? <span className="chip">Retired</span>
                  : <button type="button" className="btn small ghost" style={T14} disabled={busy === a.id} onClick={() => void retire(a)} aria-label={`Retire avatar ${a.gender} ${a.age} ${a.look}`}>Retire</button>}
              </div>
            </figcaption>
          </figure>
        ))}
      </div>
    </ConsultShell>
  );
}
