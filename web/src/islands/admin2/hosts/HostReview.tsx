/* HostReview — [HF-HOST-PLATFORM-1] Host review queue + detail drawer.
 * Worker: GET /api/admin/hf/hosts?status=, GET /api/admin/hf/hosts/:uid, POST .../decision; selfie review + signed media via /api/admin/hf/kyc.
 * Look = desi admin kit (audition cards, marquee-lit selection). No green; nothing under 14px. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { hfAdminApi, apiUrl, type AdminHost, type AdminHostDetail, type HostStatus, type KycItem } from '../../../lib/hfAdminApi';
import { dateIST, fail, track } from '../consultants/kit';
import { DesiCard, DesiChip, DesiEmpty, Marigold } from '../desi';
import { HBanner, Tick } from './hostsKit';
import { request } from '../../../lib/apiClient';
import '../../../styles/profile-card.css';

const TABS: { key: HostStatus; label: string }[] = [
  { key: 'draft', label: 'Drafts' },
  { key: 'pending_review', label: 'Pending review' }, { key: 'live', label: 'Live' }, { key: 'paused', label: 'Paused' }, { key: 'rejected', label: 'Rejected' },
];
const priceOf = (h: AdminHost, standard: boolean) => (standard && (!h.category || h.category === 'standard') ? 'Standard plan' : `₹${h.pricePerMin}/min`);
const STATUS_CHIP: Record<string, { tone: 'tea' | 'gold' | 'rani' | 'lav' | 'grey' | 'red'; label: string }> = {
  draft: { tone: 'grey', label: 'Draft' }, pending_review: { tone: 'gold', label: 'Pending review' }, live: { tone: 'tea', label: 'Live' },
  paused: { tone: 'lav', label: 'Paused' }, rejected: { tone: 'red', label: 'Rejected' },
};

export default function HostReview() {
  const [tab, setTab] = useState<HostStatus>('pending_review');
  const [rows, setRows] = useState<AdminHost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openUid, setOpenUid] = useState<string | null>(null);
  const [standard, setStandard] = useState(false);
  useEffect(() => { let live = true; void request<{ hfStdPlan?: { enabled?: boolean } }>('/api/config').then(c => { if (live) setStandard(c?.hfStdPlan?.enabled === true); }).catch(() => {}); return () => { live = false; }; }, []);

  const load = useCallback(async () => {
    setError(null); setRows(null);
    try { setRows(await hfAdminApi.hosts(tab, setRows)); } catch (e) { setError(fail('hosts_list', e, { tab })); setRows([]); }
  }, [tab]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="hfa-stack">
      <div role="tablist" aria-label="Host status" className="hfa-pills">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className="hfa-pill" onClick={() => setTab(t.key)}>
            {t.label}{tab === t.key && rows && <span className="hfh-count">{rows.length}</span>}
          </button>
        ))}
      </div>
      {error && <HBanner tone="error">{error}</HBanner>}
      {rows === null && <DesiCard tone="cream" pattern="dots"><p role="status" className="hfa-note">Loading influencers…</p></DesiCard>}
      {rows && rows.length === 0 && !error && <DesiCard tone="rani" corner="marigold"><DesiEmpty text="Nobody here." /></DesiCard>}
      {rows && rows.length > 0 && (
        <div className="hfh-wall">
          {rows.map((h) => {
            const st = STATUS_CHIP[h.status] ?? { tone: 'grey' as const, label: h.status };
            return (
              <div key={h.uid} className={`hfh-aud${openUid === h.uid ? ' is-sel' : ''}`}>
                <article className="hfh-aud-in">
                  <span className="hfa-corner" aria-hidden="true"><Marigold size={70} tone={1} /></span>
                  <div className="hfh-arch">
                    {h.avatarUrl ? <img src={h.avatarUrl} alt="" loading="lazy" /> : <span className="hfh-arch-ini" aria-hidden="true">{(h.displayName || '?').trim().charAt(0).toUpperCase()}</span>}
                  </div>
                  <div className="hfh-aud-body">
                    <b className="hfh-name">{h.displayName || 'No name'}</b>
                    {h.tagline && <span className="hfa-note">{h.tagline}</span>}
                    <span className="hfh-ticks">
                      <DesiChip tone={st.tone}>{st.label}</DesiChip>
                      <Tick on={!!h.avatarUrl}>Photo</Tick><Tick on={!!h.displayName}>Name</Tick><Tick on={!!h.tagline}>Tagline</Tick><Tick on={h.languages.length > 0}>Languages</Tick>
                    </span>
                    <div className="hfh-aud-foot">
                      <span>{h.languages.join(', ') || '—'}</span><b>{priceOf(h, standard)}</b>
                      <span>Sent {dateIST(h.submittedAt ?? h.updatedAt)}</span>
                    </div>
                    <button type="button" className="hfa-btn rani" onClick={() => setOpenUid(h.uid)} aria-label={`Open ${h.displayName || 'influencer'}`}>Open audition</button>
                  </div>
                </article>
              </div>
            );
          })}
        </div>
      )}
      {openUid && <Drawer uid={openUid} standard={standard} onClose={() => setOpenUid(null)} onChanged={() => { void load(); }} />}
    </div>
  );
}

function Drawer({ uid, standard, onClose, onChanged }: { uid: string; standard: boolean; onClose: () => void; onChanged: () => void }) {
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
  const intro = d?.intro ?? null;
  const [introReason, setIntroReason] = useState('');
  const selfie = d?.kyc.selfie;
  const ready = !!d && selfie?.status === 'approved' && !!d.kyc.payout?.nameMatch && d.media.length > 0;

  const checks = [
    { ok: !!(profile?.url || h?.avatarUrl), label: 'Profile photo' },
    { ok: selfie?.status === 'approved', label: 'Selfie approved' },
    { ok: !!d?.kyc.payout?.nameMatch, label: 'Payout name matches' },
    { ok: intro?.status === 'approved', label: 'Voice intro approved' },
  ];

  return (
    <div className="hfh-veil" role="dialog" aria-modal="true" aria-label="Influencer detail" onClick={onClose}>
      <div className="hfh-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="hfh-dhead">
          <h2>{h?.displayName || 'Influencer'}</h2>
          <button ref={closeRef} type="button" className="hfa-btn gold" onClick={onClose}>Close</button>
        </div>
        <div className="hfh-dbody">
          {error && <HBanner tone="error">{error}</HBanner>}
          {info && <HBanner tone="info">{info}</HBanner>}
          {!d && !error && <p role="status" className="hfa-note">Loading…</p>}
          {d && h && (
            <>
              <DesiCard tone="gold" corner="marigold" title="Audition checklist" pattern="dots">
                <div className="hfh-ticks">{checks.map((c) => <Tick key={c.label} on={c.ok}>{c.label}</Tick>)}</div>
              </DesiCard>

              <DesiCard tone="rani" corner="hibiscus" title="Card preview">
                <div className="hfh-hero2">
                  <div className="people-grid" style={{ maxWidth: 360 }}>
                    <article className="profile-card">
                      <div className="portrait-wrap" style={{ position: 'relative' }}>
                        {(profile?.url || h.avatarUrl) && <img className="person-portrait" src={profile?.url || h.avatarUrl || ''} alt={h.displayName || 'Influencer'} />}
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
                        <div className="person-actions"><span className="person-price">{priceOf(h, standard)}</span></div>
                      </div>
                    </article>
                  </div>
                  <dl className="hfh-kv">
                    <div><dt>Status</dt><dd>{(STATUS_CHIP[h.status] ?? { label: h.status }).label}</dd></div>
                    <div><dt>Price</dt><dd>{priceOf(h, standard)}</dd></div>
                    <div><dt>Hours</dt><dd>{h.hours.days?.join(', ') || '—'} {h.hours.from || ''}{h.hours.to ? ` to ${h.hours.to}` : ''}</dd></div>
                    <div><dt>Health consent</dt><dd>{h.healthConsent ? 'yes' : 'no'}</dd></div>
                    <div><dt>Women lane</dt><dd>{h.womenLane ? 'yes' : 'no'}</dd></div>
                    <div><dt>LGBTQ lane</dt><dd>{h.lgbtqLane ? (h.lgbtqPublic ? 'yes, public' : 'yes, private') : 'no'}</dd></div>
                  </dl>
                </div>
              </DesiCard>

              {gallery.length > 0 && (
                <DesiCard tone="cream" title="Gallery">
                  <div className="hfh-polaroids">
                    {gallery.map((g) => <figure key={g.id} className="hfh-pol"><img src={g.url} alt={g.caption || 'Gallery'} />{g.caption && <figcaption>{g.caption}</figcaption>}</figure>)}
                  </div>
                </DesiCard>
              )}

              <DesiCard tone="lav" corner="jasmine" title="Voice introduction">
                {intro ? (
                  <div className="hfa-stack">
                    <div className="hfh-acts">
                      <DesiChip tone={intro.status === 'approved' ? 'tea' : intro.status === 'rejected' ? 'red' : 'gold'}>{intro.status === 'pending' ? 'Waiting for review' : intro.status === 'approved' ? 'Approved' : 'Asked to re-record'}</DesiChip>
                      <span>Length {Math.floor(intro.seconds / 60)}:{String(intro.seconds % 60).padStart(2, '0')}</span>
                    </div>
                    <audio controls preload="metadata" src={apiUrl(intro.url)} style={{ width: '100%' }} aria-label="Host introduction" />
                    {intro.flags.length > 0 && (
                      <div role="alert" className="hfh-alert">
                        <strong>Possible contact details heard. Please check before approving:</strong>
                        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{intro.flags.map((f, i) => <li key={i}><strong>{f.type}:</strong> “{f.text}”</li>)}</ul>
                      </div>
                    )}
                    <details>
                      <summary className="hfh-summary">Transcript (made by Gemini, may have mistakes)</summary>
                      <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{intro.transcript || 'No transcript yet.'}</p>
                    </details>
                    {d.liveIntroUrl && intro.status !== 'approved' && (
                      <div>
                        <p className="hfa-eyebrow">Currently live</p>
                        <audio controls preload="none" src={apiUrl(d.liveIntroUrl)} style={{ width: '100%' }} aria-label="Introduction currently live" />
                      </div>
                    )}
                    {intro.status === 'pending' && (
                      <div className="hfa-stack">
                        <label htmlFor="hf-intro-reason" className="hfh-field">Reason (needed to ask for a new recording; shown to the host)
                          <input id="hf-intro-reason" value={introReason} onChange={(e) => setIntroReason(e.target.value)} maxLength={300} />
                        </label>
                        <div className="hfh-acts">
                          <button type="button" className="hfa-btn tea" disabled={busy} onClick={() => void run('intro_approve', () => hfAdminApi.introDecision(uid, 'approve'), false, 'Introduction approved. It is live on the card and profile.')}>Approve intro</button>
                          <button type="button" className="hfa-btn danger" disabled={busy} onClick={() => {
                            if (!introReason.trim()) { setError('Please write a reason first.'); return; }
                            void run('intro_reject', () => hfAdminApi.introDecision(uid, 'reject', introReason.trim()), false, 'Host asked to record again.').then(() => setIntroReason(''));
                          }}>Ask to re-record</button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : <DesiEmpty text="No introduction recorded yet." />}
              </DesiCard>

              <DesiCard tone="white" pattern="bahi" title="Profile text">
                <p style={{ margin: 0 }}><strong>Written by influencer:</strong> {h.about || '—'}</p>
                <p style={{ margin: '8px 0 0' }}><strong>Polished:</strong> {h.aboutPolished || '—'}</p>
                {h.quote && <p style={{ margin: '8px 0 0' }}><strong>Quote:</strong> “{h.quote}”</p>}
                {h.reviewNote && <p style={{ margin: '8px 0 0' }}><strong>Last note:</strong> {h.reviewNote}</p>}
              </DesiCard>

              <DesiCard tone="tea" corner="marigold" title="Verification">
                <dl className="hfh-kv">
                  <div><dt>Name on Aadhaar</dt><dd>{d.kyc.name || '—'}</dd></div>
                  <div><dt>Gender</dt><dd>{d.kyc.gender || '—'}</dd></div>
                  <div><dt>Aadhaar ends</dt><dd>{d.kyc.last4 || '—'}</dd></div>
                  <div><dt>18+</dt><dd>{d.kyc.ageOk ? 'yes' : 'no'}</dd></div>
                </dl>
                <div className="hfh-acts" style={{ margin: '12px 0' }}>
                  <span>Payout name match:</span>
                  <DesiChip tone={d.kyc.payout?.nameMatch ? 'tea' : 'red'}>{d.kyc.payout ? (d.kyc.payout.nameMatch ? 'Matches' : 'Does not match') : 'Not added'}</DesiChip>
                  <span>Selfie:</span>
                  <DesiChip tone={selfie?.status === 'approved' ? 'tea' : selfie?.status === 'rejected' ? 'red' : 'gold'}>{selfie ? selfie.status : 'none'}</DesiChip>
                </div>
                {kyc ? (
                  <div className="hfa-row">
                    <div><p className="hfh-id-cap">Selfie video</p><video className="hfh-media" controls playsInline src={apiUrl(kyc.selfieUrl)} /></div>
                    <div><p className="hfh-id-cap">Aadhaar photo</p>{kyc.photoUrl ? <img className="hfh-media" src={apiUrl(kyc.photoUrl)} alt="Aadhaar photo" /> : <p className="hfa-note">No photo</p>}</div>
                  </div>
                ) : <p className="hfa-note">No selfie to show.</p>}
                <p className="hfa-note">Links last 5 minutes. Every view is logged.</p>
                {selfie?.status === 'pending' && (
                  <div className="hfh-acts" style={{ marginTop: 8 }}>
                    <button type="button" className="hfa-btn tea" disabled={busy} onClick={() => void run('selfie_approve', () => hfAdminApi.selfieDecision(uid, 'approve', '', selfie.id), false, 'Selfie approved.')}>Approve selfie</button>
                    <button type="button" className="hfa-btn danger" disabled={busy} onClick={() => void run('selfie_reject', () => hfAdminApi.selfieDecision(uid, 'reject', reason, selfie.id), true, 'Selfie rejected.')}>Reject selfie</button>
                  </div>
                )}
              </DesiCard>
            </>
          )}
        </div>
        {d && h && (
          <div className="hfh-decide">
            <div className="hfh-decide-in">
              <label htmlFor="hf-reason" className="hfh-field">Reason (needed to reject or pause; shown to the host)
                <textarea id="hf-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />
              </label>
              {!ready && h.status !== 'live' && <p className="hfa-note" style={{ margin: 0 }}>Approve needs: selfie approved, payout name match and photos present.</p>}
              <div className="hfh-acts">
                {h.status !== 'live' && <button type="button" className="hfa-btn tea" disabled={busy || !ready} onClick={() => void run('host_approve', () => hfAdminApi.decide(uid, 'approve'), false, 'Host is live. They were told on WhatsApp.')}>Approve</button>}
                {h.status !== 'rejected' && <button type="button" className="hfa-btn danger" disabled={busy} onClick={() => void run('host_reject', () => hfAdminApi.decide(uid, 'reject', reason), true, 'Host sent back.')}>Send back</button>}
                {h.status === 'live' && <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => void run('host_pause', () => hfAdminApi.decide(uid, 'pause', reason), true, 'Host paused.')}>Pause</button>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
