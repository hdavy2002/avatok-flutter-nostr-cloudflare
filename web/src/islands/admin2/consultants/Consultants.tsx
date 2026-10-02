/* Consultants — [AUMFE-CONSULT-F4-1] Admin list of real consultants + the "Make consultant" form (AdminPromote mockup).
 * Worker: /api/consultants/admin/consultants (+ /:id, /attach, /detach, /photo). Admin only.
 * Entry points: "Make consultant" button; ?uid=<uid> or ?email=<email> opens the form with that user pre-filled to attach;
 * ?edit=<id> opens one consultant. A new consultant is created first, THEN attached and the portrait uploaded
 * (the photo route needs an id), so a failed upload never loses the profile. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { BRAND } from '../../../lib/brand';
import { DISCIPLINES, DISCIPLINE_LABEL, type ConsultantStatus, type Discipline } from '../../../lib/consultTypes';
import { consultAdminApi, uploadConsultantPhoto, PORTRAIT_TYPES, type AdminConsultant, type ConsultantWrite } from '../../../lib/consultAdminApi';
import { Banner, ConsultShell, ConfirmDialog, STATUS_CHIP, STATUS_LABEL, Spinner, fail, rupees, track } from './kit';
import { errMessage } from '../adminApi';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const STATUSES: ConsultantStatus[] = ['draft', 'live', 'paused'];
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

type View = { kind: 'list' } | { kind: 'form'; id: string | null };

function readEntry(): { view: View; uid: string; email: string } {
  const u = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const uid = (u.get('uid') ?? '').slice(0, 200);
  const email = (u.get('email') ?? '').slice(0, 200);
  const edit = u.get('edit');
  if (edit) return { view: { kind: 'form', id: edit.slice(0, 100) }, uid: '', email: '' };
  if (uid || email) return { view: { kind: 'form', id: null }, uid, email };
  return { view: { kind: 'list' }, uid: '', email: '' };
}
function setUrl(p: Record<string, string | null>) {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(p)) { if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); }
  history.replaceState(history.state, '', u.toString());
}

export default function Consultants() {
  const entry = useRef(readEntry()).current;
  const [view, setView] = useState<View>(entry.view);
  const [rows, setRows] = useState<AdminConsultant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefill] = useState({ uid: entry.uid, email: entry.email });

  const load = useCallback(async () => {
    setError(null);
    try { setRows(await consultAdminApi.consultants()); }
    catch (e) { setError(fail('list', e)); setRows([]); }
  }, []);
  useEffect(() => { track('list_view'); void load(); }, [load]);

  const open = (id: string | null) => { setView({ kind: 'form', id }); setUrl({ edit: id, uid: null, email: null }); window.scrollTo({ top: 0 }); };
  const back = () => { setView({ kind: 'list' }); setUrl({ edit: null, uid: null, email: null }); void load(); };

  if (view.kind === 'form') {
    const existing = view.id ? rows?.find((r) => r.id === view.id) ?? null : null;
    if (view.id && rows === null) return <ConsultShell><Spinner label="Loading consultant…" /></ConsultShell>;
    if (view.id && !existing) return <ConsultShell><Banner tone="error">That consultant was not found.</Banner><p><button className="btn ghost small" style={{ marginTop: 12 }} onClick={back}>Back to consultants</button></p></ConsultShell>;
    return <ConsultShell><ConsultantForm key={view.id ?? 'new'} existing={existing} prefill={view.id ? { uid: '', email: '' } : prefill} onBack={back} onSaved={(c) => { setRows((r) => (r ? [c, ...r.filter((x) => x.id !== c.id)] : [c])); }} /></ConsultShell>;
  }

  return (
    <ConsultShell>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <p className="muted" style={{ fontSize: 15, fontWeight: 700 }}>{rows ? `${rows.length} consultant${rows.length === 1 ? '' : 's'}` : ' '}</p>
        <button type="button" className="btn" onClick={() => { track('make_consultant_open'); open(null); }}>Make consultant</button>
      </div>
      {error && <Banner tone="error">{error} <button className="edit" onClick={load}>Try again</button></Banner>}
      {rows === null && <Spinner label="Loading consultants…" />}
      {rows && rows.length === 0 && !error && <div className="card muted" style={{ fontWeight: 700 }}>No consultants yet. Use "Make consultant" to add the first one.</div>}
      {rows && rows.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'auto', background: '#fff' }}>
          <table className="t">
            <thead><tr><th>Consultant</th><th>Disciplines</th><th>Status</th><th>Rate</th><th>Attached user</th><th>Rating</th><th></th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      {c.photo_url
                        ? <img src={c.photo_url} alt="" width={44} height={44} style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', border: '2px solid #fff', boxShadow: '0 0 0 1px #e9dfc6' }} />
                        : <span aria-hidden="true" className="chip" style={{ width: 44, height: 44, borderRadius: '50%', justifyContent: 'center' }}>{initials(c.name)}</span>}
                      <strong>{c.name}</strong>
                    </div>
                  </td>
                  <td>{c.disciplines.map((d) => DISCIPLINE_LABEL[d]?.en ?? d).join(', ') || '—'}</td>
                  <td><span className={STATUS_CHIP[c.status]}>{STATUS_LABEL[c.status] ?? c.status}</span></td>
                  <td>{rupees(c.rate)}</td>
                  <td>{c.attached_email ?? <span className="muted">not attached</span>}</td>
                  <td>{c.rating_count > 0 && c.rating_avg != null ? <><span className="stars">★</span> {c.rating_avg.toFixed(1)} <span className="muted">({c.rating_count})</span></> : <span className="muted">No reviews</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}><button type="button" className="btn small ghost" onClick={() => open(c.id)} aria-label={`Edit ${c.name}`}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ConsultShell>
  );
}

/* ── the form (AdminPromote) ────────────────────────────────────────────── */

function ConsultantForm({ existing, prefill, onBack, onSaved }: {
  existing: AdminConsultant | null; prefill: { uid: string; email: string }; onBack: () => void; onSaved: (c: AdminConsultant) => void;
}) {
  const [cur, setCur] = useState<AdminConsultant | null>(existing);
  const [name, setName] = useState(existing?.name ?? '');
  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(!!existing);
  const [discs, setDiscs] = useState<Discipline[]>(existing?.disciplines ?? []);
  const [years, setYears] = useState(existing?.years != null ? String(existing.years) : '');
  const [langs, setLangs] = useState((existing?.languages ?? []).join(', '));
  const [bio, setBio] = useState(existing?.bio ?? '');
  const [lineage, setLineage] = useState(existing?.lineage ?? '');
  const [city, setCity] = useState(existing?.city ?? '');
  const [floor, setFloor] = useState(existing?.rate_floor != null ? String(existing.rate_floor) : '300');
  const [ceil, setCeil] = useState(existing?.rate_ceil != null ? String(existing.rate_ceil) : '3000');
  const [status, setStatus] = useState<ConsultantStatus>(existing?.status ?? 'draft');
  const [attachEmail, setAttachEmail] = useState(prefill.email);
  const [attachUid] = useState(prefill.uid);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [detachAsk, setDetachAsk] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => { track('form_open', { new: !existing, prefilled: !!(prefill.uid || prefill.email) }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    if (!PORTRAIT_TYPES.includes(f.type)) { setErr('Use a JPG, PNG or WebP photo.'); return; }
    setErr(null); setFile(f);
    setPreview((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(f); });
  };
  const toggle = (d: Discipline) => setDiscs((a) => (a.includes(d) ? a.filter((x) => x !== d) : [...a, d]));

  const problems = useMemo(() => {
    const p: string[] = [];
    if (!name.trim()) p.push('Enter the public name.');
    if (!SLUG_RE.test(slug)) p.push('The page address can only use small letters, numbers and dashes.');
    if (discs.length === 0) p.push('Choose at least one discipline.');
    const fl = Number(floor), ce = Number(ceil);
    if (!Number.isInteger(fl) || !Number.isInteger(ce) || fl < 1) p.push('Rate floor and ceiling must be whole rupees.');
    else if (fl > ce) p.push('The rate floor cannot be above the ceiling.');
    if (years.trim() && !(Number.isInteger(Number(years)) && Number(years) >= 0 && Number(years) <= 80)) p.push('Years of practice must be a whole number.');
    if (attachEmail.trim() && !/^\S+@\S+\.\S+$/.test(attachEmail.trim())) p.push('That email address does not look right.');
    return p;
  }, [name, slug, discs, floor, ceil, years, attachEmail]);

  const save = async (publish: boolean) => {
    setErr(null); setNote(null);
    if (problems.length) { setErr(problems[0]); return; }
    // "Save draft" never publishes: a Live selection stays as the consultant already was (Draft for a new one).
    const next: ConsultantStatus = publish ? 'live' : status === 'live' ? (cur && cur.status !== 'live' ? cur.status : 'draft') : status;
    const body: ConsultantWrite = {
      name: name.trim(), slug, disciplines: discs, years: years.trim() ? Number(years) : null,
      languages: langs.split(',').map((s) => s.trim()).filter(Boolean), bio: bio.trim(), lineage: lineage.trim(), city: city.trim(),
      rate_floor: Number(floor), rate_ceil: Number(ceil), status: next,
    };
    setBusy(true);
    let saved = cur;
    const steps: string[] = [];
    try {
      saved = cur
        ? (await consultAdminApi.updateConsultant(cur.id, body)).consultant
        : (await consultAdminApi.createConsultant(body)).consultant;
      setCur(saved); setStatus(saved.status); onSaved(saved);
      track(publish ? 'save_publish' : 'save_draft', { ok: true, new: !cur });
      steps.push(publish ? 'Saved and published.' : 'Saved.');
    } catch (e) {
      setErr(fail(publish ? 'save_publish' : 'save_draft', e)); setBusy(false); return;
    }
    // Attach and photo are separate calls: a failure here must not hide that the profile itself was saved.
    const wantEmail = attachEmail.trim();
    if (saved && (wantEmail && wantEmail !== saved.attached_email || (attachUid && !saved.uid && !wantEmail))) {
      try {
        saved = (await consultAdminApi.attach(saved.id, wantEmail ? { email: wantEmail } : { uid: attachUid })).consultant;
        setCur(saved); onSaved(saved); steps.push('User attached.'); track('attach', { ok: true, by: wantEmail ? 'email' : 'uid' });
      } catch (e) { setErr(`${steps.join(' ')} ${fail('attach', e)}`); setBusy(false); return; }
    }
    if (saved && file) {
      try {
        const url = await uploadConsultantPhoto(saved.id, file);
        saved = { ...saved, photo_url: url ?? saved.photo_url }; setCur(saved); onSaved(saved); setFile(null); steps.push('Portrait uploaded.'); track('photo_upload', { ok: true });
      } catch (e) { captureAndSet(e); setErr(`${steps.join(' ')} The portrait did not upload: ${errMessage(e, 'please try again.')}`); setBusy(false); return; }
    }
    setNote(steps.join(' '));
    setBusy(false);
  };
  function captureAndSet(e: unknown) { fail('photo_upload', e); }

  const doDetach = async () => {
    if (!cur) return;
    setBusy(true); setErr(null);
    try {
      const c = (await consultAdminApi.detach(cur.id)).consultant;
      setCur(c); onSaved(c); setAttachEmail(''); setDetachAsk(false); track('detach', { ok: true });
    } catch (e) { setErr(fail('detach', e)); } finally { setBusy(false); }
  };

  const shownPhoto = preview ?? cur?.photo_url ?? null;
  const field = (id: string, label: string, el: ReactElement, span2 = false) => (
    <div className="field" style={span2 ? { gridColumn: 'span 2' } : undefined}><label htmlFor={id}>{label}</label>{el}</div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <span className="label"><button type="button" className="edit" style={{ padding: 0, color: 'inherit' }} onClick={onBack}>Consultants</button> › {name.trim() || 'New consultant'}</span>
          <h2 style={{ fontSize: 30, marginTop: 4 }}>{cur ? 'Edit consultant' : 'Make consultant'}</h2>
        </div>
        {cur?.attached_email
          ? <span className="chip">Attached · {cur.attached_email}</span>
          : attachUid ? <span className="chip gold">Will attach user {attachUid.slice(0, 14)}{attachUid.length > 14 ? '…' : ''}</span> : <span className="chip gold">Not attached to a user yet</span>}
      </div>
      {err && <Banner tone="error">{err}</Banner>}
      {note && <Banner tone="info">{note}</Banner>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: 28, alignItems: 'start' }} className="consult-promote-grid">
        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, maxWidth: 340 }}>
          {shownPhoto
            ? <img className="sticker" src={shownPhoto} alt={name ? `Portrait of ${name}` : 'Portrait preview'} style={{ width: 200, height: 200 }} />
            : <div className="sticker" role="img" aria-label="No portrait yet" style={{ width: 200, height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Comfortaa, sans-serif', fontSize: 56, color: 'var(--teal)' }}>{initials(name)}</div>}
          <input ref={fileRef} type="file" accept={PORTRAIT_TYPES.join(',')} hidden onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
          <button type="button" className="btn small ghost" onClick={() => fileRef.current?.click()}>{shownPhoto ? 'Replace portrait' : 'Upload portrait'}</button>
          {file && <span className="hint" style={{ textAlign: 'center' }}>{file.name} will upload when you save.</span>}
          <span className="hint" style={{ textAlign: 'center' }}>Square photo, face centred. We crop it into the round sticker.</span>
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="label" id="status-l">Status</span>
            <div role="radiogroup" aria-labelledby="status-l" style={{ display: 'flex', gap: 8 }}>
              {STATUSES.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={status === s} className={`slot${status === s ? ' on' : ''}`} style={{ flex: 1 }} onClick={() => setStatus(s)}>{STATUS_LABEL[s]}</button>
              ))}
            </div>
            <span className="hint">Only Live consultants show on the site, and only to previewers while the feature is off.</span>
          </div>
        </div>

        <div className="card" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '16px 20px', alignContent: 'start' }}>
          {field('pn', 'Public name', <input id="pn" value={name} maxLength={80} onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)); }} />)}
          {field('slug', 'Page address', <input id="slug" value={slug} maxLength={60} aria-describedby="slug-h" onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }} />)}
          <span className="hint" id="slug-h" style={{ gridColumn: 'span 2', marginTop: -8 }}>{BRAND.domain}/guides/{slug || 'page-address'}</span>
          <div className="field" style={{ gridColumn: 'span 2' }}>
            <span style={{ fontSize: 14, fontWeight: 800 }} id="disc-l">Disciplines</span>
            <div role="group" aria-labelledby="disc-l" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {DISCIPLINES.map((d) => (
                <button key={d} type="button" aria-pressed={discs.includes(d)} className={`slot${discs.includes(d) ? ' on' : ''}`} style={{ padding: '0 14px' }} onClick={() => toggle(d)}>{DISCIPLINE_LABEL[d].en}</button>
              ))}
            </div>
          </div>
          {field('yrs', 'Years of practice', <input id="yrs" inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value.replace(/\D/g, '').slice(0, 2))} />)}
          {field('lang', 'Languages', <input id="lang" value={langs} placeholder="Hindi, English" onChange={(e) => setLangs(e.target.value)} />)}
          {field('city', 'City', <input id="city" value={city} maxLength={60} onChange={(e) => setCity(e.target.value)} />)}
          {field('lin', 'Lineage', <input id="lin" value={lineage} maxLength={120} placeholder="e.g. Third-generation Samudrika family" onChange={(e) => setLineage(e.target.value)} />)}
          {field('bio', 'Short bio', <textarea id="bio" value={bio} maxLength={600} onChange={(e) => setBio(e.target.value)} />, true)}
          {field('min', 'Rate floor (₹ per session)', <input id="min" inputMode="numeric" value={floor} onChange={(e) => setFloor(e.target.value.replace(/\D/g, '').slice(0, 6))} />)}
          {field('max', 'Rate ceiling (₹ per session)', <input id="max" inputMode="numeric" value={ceil} onChange={(e) => setCeil(e.target.value.replace(/\D/g, '').slice(0, 6))} />)}
          <div className="field" style={{ gridColumn: 'span 2' }}>
            <label htmlFor="att">Attach to a user (their sign-in email)</label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <input id="att" type="email" style={{ flex: 1, minWidth: 220, minHeight: 48, border: '1.5px solid #cdbb8f', borderRadius: 12, padding: '10px 14px', font: "16px 'Nunito',sans-serif", background: '#fff', color: 'var(--ink)' }}
                value={attachEmail} placeholder={cur?.attached_email ? '' : 'name@example.com'} onChange={(e) => setAttachEmail(e.target.value)} aria-describedby="att-h" />
              {cur?.uid && <button type="button" className="btn small ghost" onClick={() => setDetachAsk(true)}>Detach user</button>}
            </div>
            <span className="hint" id="att-h">{cur?.attached_email ? `Attached to ${cur.attached_email}. Type another email and save to move it.` : 'The user then sees the consultant desk. Leave empty to attach later.'}</span>
          </div>
          <div style={{ gridColumn: 'span 2', display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 6, flexWrap: 'wrap' }}>
            <button type="button" className="btn ghost" onClick={onBack} disabled={busy}>Back</button>
            <button type="button" className="btn ghost" onClick={() => void save(false)} disabled={busy}>Save draft</button>
            <button type="button" className="btn" onClick={() => void save(true)} disabled={busy}>{busy ? 'Saving…' : 'Save and publish'}</button>
          </div>
        </div>
      </div>
      <ConfirmDialog open={detachAsk} title="Detach this user?" confirmLabel="Detach" danger busy={busy} onConfirm={() => void doDetach()} onCancel={() => setDetachAsk(false)}
        body={<>{cur?.attached_email ?? 'This user'} will lose access to the consultant desk. The profile and past bookings stay.</>} />
      <style>{`@media (max-width: 720px){.consult-ui .consult-promote-grid{grid-template-columns:minmax(0,1fr)!important}.consult-ui .consult-promote-grid>.card{max-width:none!important}.consult-ui .consult-promote-grid .card[style*="repeat(2"]{grid-template-columns:minmax(0,1fr)!important}.consult-ui .consult-promote-grid .card [style*="span 2"]{grid-column:auto!important}}`}</style>
    </div>
  );
}
