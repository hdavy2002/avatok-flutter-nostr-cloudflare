/* HostReview — [HF-HOST-PLATFORM-1] Host review queue + detail drawer.
 * Worker: GET /api/admin/hf/hosts?status=, GET /api/admin/hf/hosts/:uid, POST .../decision; selfie review + signed media via /api/admin/hf/kyc.
 * Look = consultants admin kit. No green; nothing under 14px. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { hfAdminApi, apiUrl, type AdminHost, type AdminHostDetail, type HostStatus, type KycItem } from '../../../lib/hfAdminApi';
import { Banner, ConsultShell, Spinner, dateIST, fail, track } from '../consultants/kit';
import '../../../styles/profile-card.css';

const TABS: { key: HostStatus; label: string }[] = [
  { key: 'pending_review', label: 'Pending review' }, { key: 'live', label: 'Live' }, { key: 'paused', label: 'Paused' }, { key: 'rejected', label: 'Rejected' },
];
const T14 = { fontSize: 14 } as const;
const label = { ...T14, fontWeight: 800, color: 'var(--teal, #46113e)' } as const;

export default function HostReview() {
  const [tab, setTab] = useState<HostStatus>('pending_review');
  const [rows, setRows] = useState<AdminHost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openUid, setOpenUid] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null); setRows(null);
    try { setRows(await hfAdminApi.hosts(tab)); } catch (e) { setError(fail('hosts_list', e, { tab })); setRows([]); }
  }, [tab]);
  useEffect(() => { void load(); }, [load]);

  return (
    <ConsultShell>
      <div role="tablist" aria-label="Host status" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`slot${tab === t.key ? ' on' : ''}`} style={{ padding: '0 14px', ...T14 }} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {error && <div style={{ marginBottom: 12 }}><Banner tone="error">{error}</Banner></div>}
      {rows === null && <Spinner label="Loading hosts…" />}
      {rows && rows.length === 0 && !error && <div className="card muted" style={{ fontWeight: 700, ...T14 }}>Nobody here.</div>}
      {rows && rows.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'auto', background: '#fff' }}>
          <table className="t" style={T14}>
            <thead><tr><th></th><th>Host</th><th>Languages</th><th>Price</th><th>Sent</th><th></th></tr></thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.uid}>
                  <td>{h.avatarUrl && <img src={h.avatarUrl} alt="" width={48} height={48} style={{ borderRadius: 10, objectFit: 'cover' }} />}</td>
                  <td><strong>{h.displayName || 'No name'}</strong><div className="muted" style={T14}>{h.tagline || ''}</div></td>
                  <td>{h.languages.join(', ') || '—'}</td>
                  <td>₹{h.pricePerMin}/min</td>
                  <td>{dateIST(h.submittedAt ?? h.updatedAt)}</td>
                  <td><button type="button" className="btn small" style={T14} onClick={() => setOpenUid(h.uid)} aria-label={`Open ${h.displayName || 'host'}`}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openUid && <Drawer uid={openUid} onClose={() => setOpenUid(null)} onChanged={() => { void load(); }} />}
    </ConsultShell>
  );
}

function Drawer({ uid, onClose, onChanged }: { uid: string; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<AdminHostDetail | null>(null);
  const [kyc, setKyc] = useState<KycItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const x = await hfAdminApi.host(uid);
      setD(x);
      const st = x.kyc.selfie?.status;
      setKyc(st ? await hfAdminApi.kycMedia(uid, st).catch(() => null) : null);
    } catch (e) { setError(fail('host_detail', e)); }
  }, [uid]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    closeRef.current?.focus();
    const k = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const run = async (action: string, fn: () => Promise<unknown>, needReason: boolean, done: string) => {
    if (needReason && !reason.trim()) { setError('Please write a reason first.'); return; }
    setBusy(true); setError(null); setInfo(null);
    try { await fn(); track(action, { ok: true }); setInfo(done); setReason(''); await load(); onChanged(); }
    catch (e) { setError(fail(action, e)); } finally { setBusy(false); }
  };

  const h = d?.host;
  const profile = d?.media.find((m) => m.kind === 'profile');
  const gallery = d?.media.filter((m) => m.kind === 'gallery') ?? [];
  const audio = d?.media.find((m) => m.kind === 'sample_audio');
  const selfie = d?.kyc.selfie;
  const ready = !!d && selfie?.status === 'approved' && !!d.kyc.payout?.nameMatch && d.media.some((m) => m.kind !== 'sample_audio');

  return (
    <div role="dialog" aria-modal="true" aria-label="Host detail" style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', justifyContent: 'flex-end', background: 'rgba(40,10,35,.45)' }} onClick={onClose}>
      <div className="consult-ui" onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 100%)', height: '100%', overflow: 'auto', background: '#fffdf8', padding: 20, ...T14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 22 }}>{h?.displayName || 'Host'}</h2>
          <button ref={closeRef} type="button" className="btn small ghost" style={T14} onClick={onClose}>Close</button>
        </div>
        {error && <div style={{ marginBottom: 12 }}><Banner tone="error">{error}</Banner></div>}
        {info && <div style={{ marginBottom: 12 }}><Banner tone="info">{info}</Banner></div>}
        {!d && !error && <Spinner label="Loading…" />}
        {d && h && (
          <>
            <p style={label}>Card preview</p>
            <div className="people-grid" style={{ maxWidth: 360, marginBottom: 16 }}>
              <article className="profile-card">
                <div className="portrait-wrap" style={{ position: 'relative' }}>
                  {(profile?.url || h.avatarUrl) && <img className="person-portrait" src={profile?.url || h.avatarUrl || ''} alt={h.displayName || 'Host'} />}
                  <p className="person-status is-offline">Offline</p>
                </div>
                <div className="person-copy">
                  <h3>{h.displayName || 'No name'}</h3>
                  <p className="person-tagline">{h.tagline || h.about || ''}</p>
                  <dl className="profile-card-facts">
                    <div><dt>Languages</dt><dd>{h.languages.join(', ') || '—'}</dd></div>
                    <div><dt>Style</dt><dd>{h.style || '—'}</dd></div>
                  </dl>
                  {h.topics.length > 0 && <ul className="person-moods">{h.topics.map((t) => <li key={t}>{t}</li>)}</ul>}
                  <div className="person-actions"><span className="person-price">₹{h.pricePerMin}/min</span></div>
                </div>
              </article>
            </div>

            {gallery.length > 0 && (<>
              <p style={label}>Gallery</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8, marginBottom: 16 }}>
                {gallery.map((g) => <figure key={g.id} style={{ margin: 0 }}><img src={g.url} alt={g.caption || 'Gallery'} style={{ width: '100%', borderRadius: 10, aspectRatio: '1', objectFit: 'cover' }} />{g.caption && <figcaption style={T14}>{g.caption}</figcaption>}</figure>)}
              </div>
            </>)}

            <p style={label}>Sample conversation</p>
            {audio ? (
              <div className="card" style={{ padding: 12, marginBottom: 16, background: '#fff' }}>
                <audio controls src={audio.url} style={{ width: '100%' }} />
                {audio.transcript?.map((l, i) => <p key={i} style={{ margin: '6px 0 0', ...T14 }}><strong>{l.speaker === 'host' ? 'Host' : 'Caller'}:</strong> {l.text}</p>)}
              </div>
            ) : <p className="muted" style={{ ...T14, marginBottom: 16 }}>No sample audio (voice step was skipped or not done).</p>}

            <p style={label}>Profile text</p>
            <div className="card" style={{ padding: 12, marginBottom: 16, background: '#fff' }}>
              <p style={{ margin: 0 }}><strong>Written by host:</strong> {h.about || '—'}</p>
              <p style={{ margin: '8px 0 0' }}><strong>Polished:</strong> {h.aboutPolished || '—'}</p>
              {h.quote && <p style={{ margin: '8px 0 0' }}><strong>Quote:</strong> “{h.quote}”</p>}
              <p style={{ margin: '8px 0 0' }}><strong>Hours:</strong> {h.hours.days?.join(', ') || '—'} {h.hours.from || ''}{h.hours.to ? ` to ${h.hours.to}` : ''}</p>
              <p style={{ margin: '8px 0 0' }}>Health consent: {h.healthConsent ? 'yes' : 'no'} · Women lane: {h.womenLane ? 'yes' : 'no'} · LGBTQ lane: {h.lgbtqLane ? (h.lgbtqPublic ? 'yes, public' : 'yes, private') : 'no'}</p>
              {h.reviewNote && <p style={{ margin: '8px 0 0' }}><strong>Last note:</strong> {h.reviewNote}</p>}
            </div>

            <p style={label}>Verification</p>
            <div className="card" style={{ padding: 12, marginBottom: 16, background: '#fff' }}>
              <p style={{ margin: 0 }}>Name on Aadhaar: <strong>{d.kyc.name || '—'}</strong> · Gender: <strong>{d.kyc.gender || '—'}</strong> · Aadhaar ends <strong>{d.kyc.last4 || '—'}</strong> · 18+: {d.kyc.ageOk ? 'yes' : 'no'}</p>
              <p style={{ margin: '6px 0 0' }}>Payout name match: <span className={`chip ${d.kyc.payout?.nameMatch ? 'neel' : 'red'}`}>{d.kyc.payout ? (d.kyc.payout.nameMatch ? 'Matches' : 'Does not match') : 'Not added'}</span> · Selfie: <span className={`chip ${selfie?.status === 'approved' ? 'neel' : selfie?.status === 'rejected' ? 'red' : 'gold'}`}>{selfie ? selfie.status : 'none'}</span></p>
              {kyc ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginTop: 12 }}>
                  <div><p style={label}>Selfie video</p><video controls playsInline src={apiUrl(kyc.selfieUrl)} style={{ width: '100%', borderRadius: 10, background: '#000' }} /></div>
                  <div><p style={label}>Aadhaar photo</p>{kyc.photoUrl ? <img src={apiUrl(kyc.photoUrl)} alt="Aadhaar photo" style={{ width: '100%', borderRadius: 10 }} /> : <p className="muted">No photo</p>}</div>
                </div>
              ) : <p className="muted" style={{ ...T14, marginTop: 8 }}>No selfie to show.</p>}
              <p className="muted" style={{ ...T14, marginTop: 8 }}>Links last 5 minutes. Every view is logged.</p>
              {selfie?.status === 'pending' && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  <button type="button" className="btn small" style={T14} disabled={busy} onClick={() => void run('selfie_approve', () => hfAdminApi.selfieDecision(uid, 'approve', '', selfie.id), false, 'Selfie approved.')}>Approve selfie</button>
                  <button type="button" className="btn small ghost" style={T14} disabled={busy} onClick={() => void run('selfie_reject', () => hfAdminApi.selfieDecision(uid, 'reject', reason, selfie.id), true, 'Selfie rejected.')}>Reject selfie</button>
                </div>
              )}
            </div>

            <label htmlFor="hf-reason" style={label}>Reason (needed to reject or pause; shown to the host)</label>
            <textarea id="hf-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} style={{ width: '100%', margin: '6px 0 12px', padding: 10, borderRadius: 10, border: '1px solid #d9cbd6', ...T14 }} />
            {!ready && h.status !== 'live' && <p className="muted" style={{ ...T14, margin: '0 0 8px' }}>Approve needs: selfie approved, payout name match and photos present.</p>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {h.status !== 'live' && <button type="button" className="btn" style={T14} disabled={busy || !ready} onClick={() => void run('host_approve', () => hfAdminApi.decide(uid, 'approve'), false, 'Host is live. They were told on WhatsApp.')}>Approve host</button>}
              {h.status !== 'rejected' && <button type="button" className="btn ghost" style={T14} disabled={busy} onClick={() => void run('host_reject', () => hfAdminApi.decide(uid, 'reject', reason), true, 'Host sent back.')}>Reject</button>}
              {h.status === 'live' && <button type="button" className="btn ghost" style={T14} disabled={busy} onClick={() => void run('host_pause', () => hfAdminApi.decide(uid, 'pause', reason), true, 'Host paused.')}>Pause</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
