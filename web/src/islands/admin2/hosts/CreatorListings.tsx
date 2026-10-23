import { useCallback, useEffect, useState } from 'react';
import { creatorAdminApi, mp3Duration, type CreatorListing, type CreatorPreview } from '../../../lib/hfCreatorAdminApi';
import CreatorVoiceRecorder from './CreatorVoiceRecorder';
import { hfAdminApi, apiUrl, type AdminIntro, type AdminUserHit } from '../../../lib/hfAdminApi';
import { Banner, ConsultShell, fail } from '../consultants/kit';

const field = { width: '100%', minHeight: 44, padding: 10, border: '1px solid #c8afd1', borderRadius: 10, fontSize: 15 } as const;
const grid = { display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' } as const;
const editable = (l: CreatorListing) => ['draft', 'pending_host', 'paused', 'rejected'].includes(l.status);
const blockerNames: Record<string, string> = { sample_data: 'Create a draft for a real host account to publish this profile.', whatsapp: 'WhatsApp number verified by OTP', profile: 'Name, tagline and about', price: 'Valid creator price', agreements: 'Host agreement acceptance', voice: 'Approved voice introduction (20 seconds minimum)', profile_media: 'Profile image' };

export default function CreatorListings() {
  const [rows, setRows] = useState<CreatorListing[]>([]), [listing, setListing] = useState<CreatorListing | null>(null);
  const [intro, setIntro] = useState<AdminIntro | null>(null), [error, setError] = useState(''), [info, setInfo] = useState(''), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''), [users, setUsers] = useState<AdminUserHit[]>([]), [chosen, setChosen] = useState<AdminUserHit | null>(null);
  const [category, setCategory] = useState<'influencer' | 'celebrity'>('influencer'), [consent, setConsent] = useState(false), [reason, setReason] = useState('');
  const [selectedMp3, setSelectedMp3] = useState<{ file: File; seconds: number } | null>(null);
  const [clipUrl, setClipUrl] = useState(''), [preview, setPreview] = useState<CreatorPreview | null>(null);
  useEffect(() => {
    if (!selectedMp3) { setClipUrl(''); return; }
    const url = URL.createObjectURL(selectedMp3.file); setClipUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedMp3]);
  const refresh = useCallback(async () => setRows((await creatorAdminApi.list()).items), []);
  useEffect(() => { void refresh().catch(e => setError(fail('creator_list', e))); }, [refresh]);
  const open = async (uid: string) => {
    const result = await creatorAdminApi.get(uid); setListing(result.listing);
    setIntro((await hfAdminApi.host(uid)).intro); setSelectedMp3(null); setConsent(false); setPreview(null);
  };
  const run = async (fn: () => Promise<void>, message = '') => {
    setBusy(true); setError(''); setInfo('');
    try { await fn(); await refresh(); setInfo(message); } catch (e) { setError(fail('creator_listing', e)); } finally { setBusy(false); }
  };
  const change = (patch: Partial<CreatorListing>) => setListing(l => l ? { ...l, ...patch } : l);
  const locked = !listing || !editable(listing);
  return <ConsultShell>
    <p>Create a draft for an existing host account. Publishing requires a WhatsApp-verified number, a voice intro and the agreement.</p>
    {error && <Banner tone="error">{error}</Banner>}{info && <Banner tone="info">{info}</Banner>}
    <section className="card" style={{ margin: '16px 0' }} aria-label="Create a creator listing">
      <h2>Create draft</h2>
      <div style={grid}>
        <label>Find the host<input style={field} value={query} onChange={e => { setQuery(e.target.value); setChosen(null); }} placeholder="Name, email or verified phone" /></label>
        <label>Category<select style={field} value={category} onChange={e => setCategory(e.target.value as typeof category)}><option value="influencer">Influencer</option><option value="celebrity">Celebrity</option></select></label>
      </div>
      <button className="btn small" disabled={busy || query.trim().length < 2} onClick={() => void run(async () => setUsers(await hfAdminApi.searchUsers(query.trim())))}>Find host</button>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>{users.map(u => <button key={u.uid} className={`slot${chosen?.uid === u.uid ? ' on' : ''}`} disabled={busy} onClick={() => setChosen(u)}>{u.name || u.email || 'Host account'} · {u.email || u.phone || u.uid}</button>)}</div>
      <button className="btn" style={{ marginTop: 12 }} disabled={busy || !chosen} onClick={() => void run(async () => { const r = await creatorAdminApi.create(chosen!.uid, category); await open(r.listing.uid); }, 'Draft created.')}>Create draft</button>
      <button className="btn ghost" style={{ margin: '12px 0 0 8px' }} disabled={busy} onClick={() => void run(async () => { await creatorAdminApi.seed(); }, 'Sample drafts added for private review. They are offline and cannot be published.')}>Add sample drafts</button>
    </section>
    <section className="card" aria-label="Creator listings">
      <h2>Creator listings</h2>
      {!rows.length && <p>No creator drafts yet.</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{rows.map(r => <button className="slot" key={r.uid} disabled={busy} onClick={() => void run(() => open(r.uid))}>{r.displayName || 'Untitled'} · {r.category} · {r.status}</button>)}</div>
    </section>
    {listing && <section className="card" style={{ marginTop: 16 }} aria-label="Edit creator listing">
      <h2>{listing.displayName || 'Untitled creator'} <small>· {listing.status}</small></h2>
      {locked && <p>Pause the live listing in <a href="/admin/hosts">Host review</a> before editing.</p>}
      <fieldset disabled={busy || locked} style={{ border: 0, padding: 0 }}>
        <div style={grid}>
          <label>Display name<input style={field} maxLength={40} value={listing.displayName ?? ''} onChange={e => change({ displayName: e.target.value })} /></label>
          <label>Category<select style={field} value={listing.category} onChange={e => change({ category: e.target.value as CreatorListing['category'] })}><option value="influencer">Influencer</option><option value="celebrity">Celebrity</option></select></label>
          <label>Fan price per minute (₹)<input style={field} type="number" min={5} max={1000} step={1} value={listing.pricePerMin} onChange={e => change({ pricePerMin: Number(e.target.value) })} /></label>
          <label>Private host phone (optional)<input style={field} type="tel" autoComplete="off" placeholder="+91…" value={listing.privatePhone ?? ''} onChange={e => change({ privatePhone: e.target.value || null })} /><small>Encrypted, admin-only; never on public cards. Calls use the verified account number.</small></label>
        </div>
        <p>We keep ₹2 a minute plus 40% of the rate above ₹2, including its GST. The creator keeps the rest.</p>
        <label>Tagline<input style={field} maxLength={120} value={listing.tagline ?? ''} onChange={e => change({ tagline: e.target.value })} /></label>
        <label>About<textarea style={field} rows={4} maxLength={600} value={listing.about ?? ''} onChange={e => change({ about: e.target.value })} /></label>
        <label>Languages (comma separated)<input style={field} value={listing.languages.join(', ')} onChange={e => change({ languages: e.target.value.split(',').map(s => s.trim()) })} /></label>
        <button className="btn" style={{ marginTop: 12 }} onClick={() => void run(async () => { const r = await creatorAdminApi.save(listing.uid, listing.listingRevision, { category: listing.category, pricePerMin: listing.pricePerMin, displayName: listing.displayName ?? '', tagline: listing.tagline ?? '', about: listing.about ?? '', languages: listing.languages.filter(Boolean), privatePhone: listing.privatePhone ?? null }); setListing(r.listing); }, 'Draft saved.')}>Save draft</button>
      </fieldset>
      <h3>Profile image</h3>
      {listing.media?.filter(m => m.kind === 'profile').map(m => <img key={m.id} src={m.url} alt="Profile preview" width={140} height={170} style={{ objectFit: 'cover', borderRadius: 12 }} />)}
      <label style={{ display: 'block' }}>Upload or replace profile image<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || locked} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void run(async () => { const r = await creatorAdminApi.upload(listing.uid, 'profile', file); setListing(r.listing); }, 'Image uploaded.'); }} /></label>
      <h3>Voice recording</h3>
      <div style={{ border: '1px dashed #a489a7', borderRadius: 12, padding: 16 }}>
        <p>{intro ? `Recording uploaded · ${intro.status} · ${intro.seconds} seconds` : 'No voice recording uploaded yet.'}</p>
        {intro && <audio controls src={apiUrl(intro.url)} style={{ width: '100%' }} />}
        <p>Record the host’s own introduction here or select an MP3. Minimum 20 seconds; maximum 5 minutes and 15 MB.</p>
        <CreatorVoiceRecorder key={listing.uid} disabled={busy || locked} onError={setError} onClip={(file, seconds) => { setSelectedMp3({ file, seconds }); setConsent(false); setError(''); }} />
        <label>Select or replace MP3<input type="file" accept=".mp3,audio/mpeg,audio/mp3" disabled={busy || locked} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; setSelectedMp3(null); if (file) void run(async () => { const seconds = await mp3Duration(file); setSelectedMp3({ file, seconds }); }); }} /></label>
        {selectedMp3 && <p>{selectedMp3.file.name} · {selectedMp3.seconds.toFixed(1)} seconds</p>}
        {clipUrl && <audio controls src={clipUrl} style={{ width: '100%' }} />}
        <label style={{ display: 'block', margin: '12px 0' }}><input type="checkbox" checked={consent} disabled={busy || locked} onChange={e => setConsent(e.target.checked)} /> The host has consented to use this voice introduction.</label>
        <button className="btn small" disabled={busy || locked || !selectedMp3 || !consent} onClick={() => void run(async () => { await creatorAdminApi.upload(listing.uid, 'voice', selectedMp3!.file, selectedMp3!.seconds); await open(listing.uid); }, 'Voice uploaded for review.')}>{intro ? 'Replace voice upload' : 'Upload voice clip'}</button>
        {selectedMp3 && <button className="btn small ghost" disabled={busy} onClick={() => { setSelectedMp3(null); setConsent(false); }}>Clear selected clip</button>}
        {(intro || listing.media?.some(m => m.kind === 'intro_audio')) && <button className="btn small ghost" disabled={busy || locked} onClick={() => void run(async () => { await creatorAdminApi.removeVoice(listing.uid); await open(listing.uid); }, 'Voice recording removed.')}>Remove voice recording</button>}
      </div>
      {intro?.status === 'pending' && <div style={{ marginTop: 12 }}>
        <p>Listen before approving. {intro.flags.length ? 'Automated review flagged content; inspect the transcript and flags below.' : ''}</p>
        <p>{intro.transcript || 'Transcript not available yet.'}</p>
        {intro.flags.map((f, i) => <p key={i}>{f.type}: {f.text}</p>)}
        <input style={field} aria-label="Reason for rejecting voice" placeholder="Reason if asking for another recording" value={reason} onChange={e => setReason(e.target.value)} />
        <button className="btn small" disabled={busy} onClick={() => void run(async () => { await hfAdminApi.introDecision(listing.uid, 'approve'); await open(listing.uid); }, 'Voice approved.')}>Approve voice</button>
        <button className="btn small ghost" disabled={busy || !reason.trim()} onClick={() => void run(async () => { await hfAdminApi.introDecision(listing.uid, 'reject', reason.trim()); await open(listing.uid); }, 'Voice rejected.')}>Ask for new recording</button>
      </div>}
      <h3>Publication checklist</h3>
      <button className="btn small ghost" disabled={busy} onClick={() => void run(async () => setPreview((await creatorAdminApi.preview(listing.uid)).item))}>Preview card</button>
      {preview && <article aria-label="Private card preview" style={{ border: '1px solid #c8afd1', borderRadius: 16, padding: 16, maxWidth: 280, marginTop: 12 }}>
        {preview.avatarUrl && <img src={preview.avatarUrl} alt="" width={240} height={180} style={{ maxWidth: '100%', objectFit: 'cover', borderRadius: 12 }} />}
        <h3>{preview.displayName || 'Untitled'}</h3><p>{preview.tagline}</p><p>{preview.languages.join(' · ')}</p><p>{preview.priceLabel} · Offline</p>
        {preview.introAudioUrl && <audio controls src={preview.introAudioUrl} style={{ width: '100%' }} />}
      </article>}
      {(listing.publicationBlockers ?? []).length ? <ul>{listing.publicationBlockers!.map(b => <li key={b}>{blockerNames[b] ?? b}</li>)}</ul> : <p>Publication checks complete.</p>}
      <p><a href="/admin/hosts">Open host and video KYC review</a></p>
      <button className="btn" disabled={busy || listing.status === 'live' || !!listing.publicationBlockers?.length} onClick={() => void run(async () => { const r = await creatorAdminApi.publish(listing.uid); setListing(r.listing); }, 'Listing published.')}>Publish listing</button>
      <button className="btn ghost" disabled={busy || locked} style={{ marginLeft: 8 }} onClick={() => void run(async () => { await creatorAdminApi.archive(listing.uid); setListing(null); }, 'Draft archived.')}>Archive draft</button>
    </section>}
  </ConsultShell>;
}
