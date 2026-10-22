import { useCallback, useEffect, useState } from 'react';
import { apiUrl, hfAdminApi, type KycItem } from '../../../lib/hfAdminApi';
import { Clapperboard, IdCard, Phone } from 'lucide-react';
import { dateIST, fail } from '../consultants/kit';
import { DesiCard, DesiChip, DesiEmpty, DesiKpi, DesiKpis, Marigold } from '../desi';
import { HBanner } from './hostsKit';

type Tab = 'pending' | 'approved' | 'rejected';
const tabs: { key: Tab; label: string }[] = [
  { key: 'pending', label: 'Waiting' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

export default function KycReviews() {
  const [tab, setTab] = useState<Tab>('pending');
  const [items, setItems] = useState<KycItem[] | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    setItems(null); setError(null);
    try { setItems(await hfAdminApi.kycList(tab, setItems)); }
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

  const applicants = items?.filter((i) => i.aadhaar?.role === 'host').length ?? 0;
  return <div className="hfa-stack">
    <div role="tablist" aria-label="Video KYC status" className="hfa-pills">
      {tabs.map((entry) => <button key={entry.key} type="button" role="tab" aria-selected={tab === entry.key} className="hfa-pill" onClick={() => setTab(entry.key)}>{entry.label}</button>)}
    </div>
    <DesiKpis>
      <DesiKpi tone="plum" label={tabs.find((t) => t.key === tab)?.label ?? ''} value={items ? items.length : '…'} sub="IDs in this list" icon={<IdCard aria-hidden="true" />} />
      <DesiKpi tone="lav" label="Creator applicants" value={items ? applicants : '…'} icon={<Clapperboard aria-hidden="true" />} />
      <DesiKpi tone="gold" label="Caller verifications" value={items ? items.length - applicants : '…'} icon={<Phone aria-hidden="true" />} />
    </DesiKpis>
    {error && <HBanner tone="error">{error}</HBanner>}
    {info && <HBanner tone="info">{info}</HBanner>}
    {items === null && <DesiCard tone="cream" pattern="dots"><p role="status" className="hfa-note">Loading video KYC reviews…</p></DesiCard>}
    {items?.length === 0 && !error && <DesiCard tone="lav" corner="marigold"><DesiEmpty text="Nothing here." /></DesiCard>}
    <div className="hfh-idlist">
      {items?.map((item) => <article className="hfh-id" key={item.selfieId}>
        <div className="hfh-id-in">
          <span className="hfa-corner" aria-hidden="true"><Marigold size={92} /></span>
          <div className="hfh-id-media">
            <div><p className="hfh-id-cap">Selfie video</p><div className="hfh-id-photo"><video controls playsInline preload="metadata" src={apiUrl(item.selfieUrl)} style={{ width: '100%', display: 'block', background: '#000' }} /></div></div>
            <div><p className="hfh-id-cap">Identity photo</p>{item.photoUrl ? <div className="hfh-id-photo"><img src={apiUrl(item.photoUrl)} alt="Identity document portrait" /></div> : <p className="hfa-note">No identity photo supplied.</p>}</div>
          </div>
          <div className="hfh-id-det">
            <DesiChip tone="lav">{item.aadhaar?.role === 'host' ? 'Creator applicant' : 'Caller verification'}</DesiChip>
            <h3 className="hfh-id-name">{item.aadhaar?.name || item.email || item.uid}</h3>
            {item.email && <span className="hfa-note">{item.email}</span>}
            {item.createdAt && <span className="hfa-note">{dateIST(item.createdAt)}</span>}
            <p style={{ margin: 0 }}>Identity: {item.aadhaar ? `${item.aadhaar.gender} · Aadhaar ending ${item.aadhaar.last4 || '—'}` : 'identity data unavailable'}</p>
            <span className="hfh-id-code">Spoken code <b>{item.code || '—'}</b></span>
            {item.reason && <p className="hfa-note" style={{ margin: 0 }}>Reason: {item.reason}</p>}
          </div>
          {tab === 'pending' && <div className="hfh-id-decide">
            <label htmlFor={`reason-${item.selfieId}`} className="hfh-field">Reason if asking for a new recording
              <textarea id={`reason-${item.selfieId}`} rows={2} maxLength={500} value={reason[item.selfieId] || ''} onChange={(event) => setReason((current) => ({ ...current, [item.selfieId]: event.target.value }))} />
            </label>
            <div className="hfh-acts">
              <button type="button" className="hfa-btn tea" disabled={busy === item.selfieId} onClick={() => void decide(item, 'approve')}>Approve video KYC</button>
              <button type="button" className="hfa-btn danger" disabled={busy === item.selfieId || (reason[item.selfieId] || '').trim().length < 3} onClick={() => void decide(item, 'reject')}>Record again</button>
            </div>
          </div>}
        </div>
        <div className="hfh-id-stripe" aria-hidden="true" />
      </article>)}
    </div>
  </div>;
}
