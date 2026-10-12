import { useCallback, useEffect, useState } from 'react';
import { apiUrl, hfAdminApi, type KycItem } from '../../../lib/hfAdminApi';
import { Banner, ConsultShell, Spinner, dateIST, fail } from '../consultants/kit';

type Tab = 'pending' | 'approved' | 'rejected';
const tabs: { key: Tab; label: string }[] = [
  { key: 'pending', label: 'Waiting' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];
const text14 = { fontSize: 14 } as const;

export default function KycReviews() {
  const [tab, setTab] = useState<Tab>('pending');
  const [items, setItems] = useState<KycItem[] | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    setItems(null); setError(null);
    try { setItems(await hfAdminApi.kycList(tab)); }
    catch (e) { setItems([]); setError(fail('kyc_reviews_list', e, { tab })); }
  }, [tab]);
  useEffect(() => { void load(); }, [load]);

  const decide = async (item: KycItem, decision: 'approve' | 'reject') => {
    const why = (reason[item.selfieId] || '').trim();
    if (decision === 'reject' && why.length < 3) return;
    setBusy(item.selfieId); setError(null); setInfo(null);
    try {
      await hfAdminApi.selfieDecision(item.uid, decision, why, item.selfieId);
      setInfo(decision === 'approve' ? 'Video KYC approved.' : 'A new recording was requested.');
      await load();
    } catch (e) { setError(fail(`kyc_${decision}`, e, { uid: item.uid })); }
    setBusy(null);
  };

  return <ConsultShell>
    <div role="tablist" aria-label="Video KYC status" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
      {tabs.map((entry) => <button key={entry.key} type="button" role="tab" aria-selected={tab === entry.key} className={`slot${tab === entry.key ? ' on' : ''}`} style={{ padding: '0 14px', ...text14 }} onClick={() => setTab(entry.key)}>{entry.label}</button>)}
    </div>
    {error && <div style={{ marginBottom: 12 }}><Banner tone="error">{error}</Banner></div>}
    {info && <div style={{ marginBottom: 12 }}><Banner tone="info">{info}</Banner></div>}
    {items === null && <Spinner label="Loading video KYC reviews…" />}
    {items?.length === 0 && !error && <div className="card muted" style={text14}>Nothing here.</div>}
    <div style={{ display: 'grid', gap: 16 }}>
      {items?.map((item) => <article className="card" key={item.selfieId} style={{ display: 'grid', gap: 12, background: '#fff' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', ...text14 }}>
          <strong>{item.aadhaar?.name || item.email || item.uid}</strong>
          {item.email && <span className="muted">{item.email}</span>}
          <span className="chip neel">{item.aadhaar?.role === 'host' ? 'Creator applicant' : 'Caller verification'}</span>
          {item.createdAt && <span className="muted">{dateIST(item.createdAt)}</span>}
        </div>
        <p style={{ margin: 0, ...text14 }}>Identity: {item.aadhaar ? `${item.aadhaar.gender} · Aadhaar ending ${item.aadhaar.last4 || '—'}` : 'identity data unavailable'} · spoken code {item.code || '—'}</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 12 }}>
          <div><strong style={text14}>Selfie video</strong><video controls playsInline preload="metadata" src={apiUrl(item.selfieUrl)} style={{ width: '100%', borderRadius: 10, background: '#000', marginTop: 6 }} /></div>
          <div><strong style={text14}>Identity photo</strong>{item.photoUrl ? <img src={apiUrl(item.photoUrl)} alt="Identity document portrait" style={{ width: '100%', borderRadius: 10, marginTop: 6 }} /> : <p className="muted" style={text14}>No identity photo supplied.</p>}</div>
        </div>
        {item.reason && <p className="muted" style={{ margin: 0, ...text14 }}>Reason: {item.reason}</p>}
        {tab === 'pending' && <div style={{ display: 'grid', gap: 8 }}>
          <label htmlFor={`reason-${item.selfieId}`} style={{ fontWeight: 800, ...text14 }}>Reason if asking for a new recording</label>
          <textarea id={`reason-${item.selfieId}`} rows={2} maxLength={500} value={reason[item.selfieId] || ''} onChange={(event) => setReason((current) => ({ ...current, [item.selfieId]: event.target.value }))} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn small" disabled={busy === item.selfieId} onClick={() => void decide(item, 'approve')}>Approve video KYC</button>
            <button type="button" className="btn small red" disabled={busy === item.selfieId || (reason[item.selfieId] || '').trim().length < 3} onClick={() => void decide(item, 'reject')}>Record again</button>
          </div>
        </div>}
      </article>)}
    </div>
  </ConsultShell>;
}
