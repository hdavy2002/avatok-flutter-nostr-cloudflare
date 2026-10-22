/* Avatars — [HF-HOST-PLATFORM-1] Avatar library: filters, generate a batch, retire.
 * Worker: GET /api/admin/hf/avatars, POST /generate, POST /:id/retire. No green; nothing under 14px. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { hfAdminApi, type AdminAvatar, type AvatarJob } from '../../../lib/hfAdminApi';
import { dateIST, fail, track } from '../consultants/kit';
import { DesiCard, DesiChip, DesiEmpty } from '../desi';
import { HBanner } from './hostsKit';

const GENDERS = ['woman', 'man'], AGES = ['20s', '30s', '40s', '50s+'], LOOKS = ['traditional', 'casual', 'office'];
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
    try { const r = await hfAdminApi.avatars((c) => { setItems(c.items ?? []); setJobs(c.jobs ?? []); }); setItems(r.items ?? []); setJobs(r.jobs ?? []); } catch (e) { setError(fail('avatars_list', e)); setItems([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => (items ?? []).filter((a) =>
    (!f.gender || a.gender === f.gender) && (!f.age || a.age === f.age) && (!f.look || a.look === f.look) && (!f.state || a.status === f.state)), [items, f]);

  const generate = async () => {
    setBusy('gen'); setError(null); setInfo(null);
    try { await hfAdminApi.generateAvatars(g); track('avatars_generate', { ok: true }); setInfo('Batch started. New pictures appear here in a few minutes. Press Refresh.'); await load(); }
    catch (e) { setError(fail('avatars_generate', e)); } finally { setBusy(null); }
  };
  const fill = async () => {
    if (!window.confirm('Generate the missing avatars so every gender, age and look has 4? This runs one image at a time and takes a while.')) return;
    setBusy('fill'); setError(null); setInfo(null);
    try {
      const r = await hfAdminApi.fillAvatars(4);
      track('avatars_fill', { ok: true, queued: r.queued });
      setInfo(r.queued === 0 ? 'Nothing missing. Every gender, age and look already has 4.' : `Started: ${r.queued} pictures queued, one at a time. Press Refresh to see progress.`);
      await load();
    } catch (e) { setError(fail('avatars_fill', e)); } finally { setBusy(null); }
  };
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of items ?? []) if (a.status === 'active') { const k = `${a.gender}|${a.age}|${a.look}`; m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  }, [items]);
  const retire = async (a: AdminAvatar) => {
    setBusy(a.id); setError(null);
    try { await hfAdminApi.retireAvatar(a.id); track('avatar_retire', { ok: true }); await load(); }
    catch (e) { setError(fail('avatar_retire', e)); } finally { setBusy(null); }
  };

  return (
    <div className="hfa-stack">
      <DesiCard tone="saffron" corner="marigold" title="Make a new batch" note="Pick the face, then press go.">
        <div className="hfa-stack">
          <div className="hfh-fields">
            <label className="hfh-field">How many (up to 12)<input type="number" min={1} max={12} value={g.count} onChange={(e) => setG({ ...g, count: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })} /></label>
            <label className="hfh-field">Gender<select value={g.gender} onChange={(e) => setG({ ...g, gender: e.target.value })}>{GENDERS.map((x) => <option key={x}>{x}</option>)}</select></label>
            <label className="hfh-field">Age<select value={g.age} onChange={(e) => setG({ ...g, age: e.target.value })}>{AGES.map((x) => <option key={x}>{x}</option>)}</select></label>
            <label className="hfh-field">Look<select value={g.look} onChange={(e) => setG({ ...g, look: e.target.value })}>{LOOKS.map((x) => <option key={x}>{x}</option>)}</select></label>
          </div>
          <div className="hfh-acts">
            <button type="button" className="hfa-btn" disabled={busy === 'gen'} onClick={() => void generate()}>{busy === 'gen' ? 'Starting…' : 'Generate batch'}</button>
            <button type="button" className="hfa-btn ghost" disabled={busy === 'fill'} onClick={() => void fill()}>{busy === 'fill' ? 'Starting…' : 'Fill catalogue to 4 each'}</button>
          </div>
          {items && (
            <div className="hfh-scroll" role="group" aria-label="Active avatars per combination (target 4)">
              <p style={{ fontWeight: 800, margin: '0 0 6px' }}>Active avatars per combination (target 4)</p>
              <div className="hfh-matrix">
                <span className="h l">Gender · look</span>{AGES.map((x) => <span key={x} className="h">{x}</span>)}
                {GENDERS.flatMap((gd) => LOOKS.flatMap((lk) => [
                  <span key={`${gd}-${lk}`} className="l">{gd} · {lk}</span>,
                  ...AGES.map((ag) => { const n = counts.get(`${gd}|${ag}|${lk}`) ?? 0; return <span key={`${gd}-${lk}-${ag}`} className={n < 4 ? 'low' : ''}>{n}</span>; }),
                ]))}
              </div>
            </div>
          )}
          {jobs.length > 0 && <p style={{ margin: 0 }}>Recent batches: {jobs.map((j) => `${j.status}${j.error ? ` (${j.error})` : ''} · ${dateIST(j.created_at)}`).join('  |  ')}</p>}
        </div>
      </DesiCard>

      <DesiCard tone="lav" title="Find a face" action={<button type="button" className="hfa-btn ghost" onClick={() => void load()}>Refresh</button>}>
        <div className="hfh-fields">
          <label className="hfh-field">Gender<select value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })}><option value="">All</option>{GENDERS.map((x) => <option key={x}>{x}</option>)}</select></label>
          <label className="hfh-field">Age<select value={f.age} onChange={(e) => setF({ ...f, age: e.target.value })}><option value="">All</option>{AGES.map((x) => <option key={x}>{x}</option>)}</select></label>
          <label className="hfh-field">Look<select value={f.look} onChange={(e) => setF({ ...f, look: e.target.value })}><option value="">All</option>{LOOKS.map((x) => <option key={x}>{x}</option>)}</select></label>
          <label className="hfh-field">Show<select value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}><option value="active">Active</option><option value="retired">Retired</option><option value="">Both</option></select></label>
        </div>
      </DesiCard>

      {error && <HBanner tone="error">{error}</HBanner>}
      {info && <HBanner tone="info">{info}</HBanner>}
      {items === null && <DesiCard tone="cream" pattern="dots"><p role="status" className="hfa-note">Loading avatars…</p></DesiCard>}
      {items && shown.length === 0 && !error && <DesiCard tone="rani" corner="marigold"><DesiEmpty text="No avatars match." /></DesiCard>}
      {shown.length > 0 && (
        <DesiCard tone="cream" pattern="dots" corner="jasmine">
          <div className="hfh-polaroids">
            {shown.map((a) => (
              <figure key={a.id} className={`hfh-pol${a.status === 'retired' ? ' is-retired' : ''}`}>
                <img src={a.url} alt={`${a.gender}, ${a.age}, ${a.look}`} loading="lazy" />
                <figcaption>
                  <span>{a.gender} · {a.age} · {a.look}</span>
                  <span className="hfh-acts">
                    {a.taken && <DesiChip tone="gold">Taken</DesiChip>}
                    {a.status === 'retired' ? <DesiChip tone="grey">Retired</DesiChip>
                      : <button type="button" className="hfh-chipbtn" disabled={busy === a.id} onClick={() => void retire(a)} aria-label={`Retire avatar ${a.gender} ${a.age} ${a.look}`}>Retire</button>}
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        </DesiCard>
      )}
    </div>
  );
}
