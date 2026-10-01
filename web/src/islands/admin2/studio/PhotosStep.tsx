/* PhotosStep — [AUMFE-POD-STUDIO-WEB-1 2026-10-01] Step 4 "Your photos", replica of Specs/studio-mockup/Photos.dc.html.
 * The owner uploads his own model photos (multi-file / drag-drop), tags each with the shirt colour it shows, sets the main one,
 * reorders by dragging and removes. Photos are for the shop page ONLY — nothing is ever taken from them for printing.
 * "Plain shirt pictures" (print on a flat shirt per chosen colour + a print close-up) are drawn in the browser from the saved
 * print file (lib/composite.ts, loaded on demand) and uploaded automatically as flat / closeup; they are re-made when the print
 * file's version changes. Deliberate difference: the mockup's "Shirt looks Black ✓" chip needs image recognition we do not have,
 * so the chip shows the colour the owner tagged and whether that colour is one the design sells. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../../../components/ui/sonner';
import { capture, captureException } from '../../../lib/analytics';
import {
  PRINT_SPECS, areaFor, errMessage, getFits, hexForColour, stepHref, updatePhoto, uploadPhoto,
  type Design, type Fits, type StudioPhoto,
} from '../../../lib/studioApi';
import { advanceTo } from './UploadStep';
import { LoadError, Loading, Page, Steps, TopBar, go, useDesign } from './StudioKit';

const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const plainKey = (id: string): string => `studio:plain:${id}`;
const readVer = (id: string): number | null => { try { const v = localStorage.getItem(plainKey(id)); return v === null ? null : Number(v); } catch { return null; } };
const writeVer = (id: string, v: number): void => { try { localStorage.setItem(plainKey(id), String(v)); } catch { /* per-viewer convenience only */ } };

function sortModels(photos: StudioPhoto[]): StudioPhoto[] {
  return photos.filter((p) => p.kind === 'model' && p.status === 'kept').sort((a, b) => Number(b.is_main) - Number(a.is_main) || a.sort - b.sort);
}

export default function PhotosStep({ designId }: { designId: string }) {
  const { design, error, reload } = useDesign(designId);
  const [fits, setFits] = useState<Fits | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [plainBusy, setPlainBusy] = useState(false);
  const [plainErr, setPlainErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const plainRan = useRef(false);

  useEffect(() => { capture('studio_viewed', { step: 'photos' }); }, []);
  useEffect(() => {
    let live = true;
    getFits(designId).then((f) => { if (live) setFits(f); }).catch((e) => captureException(e, { where: 'studio_fits' }));
    return () => { live = false; };
  }, [designId]);

  const colours = useMemo(() => design?.colours ?? [], [design]);

  /* ── plain-shirt pictures, made automatically ── */
  const makePlain = useCallback(async (d: Design): Promise<void> => {
    if (!d.print_url || !d.placement || d.colours.length === 0) return;
    const rec = readVer(d.id);
    const stale = rec !== null && rec !== d.version;
    const live = d.photos.filter((p) => p.status === 'kept');
    const flats = stale ? [] : live.filter((p) => p.kind === 'flat');
    const closeups = stale ? [] : live.filter((p) => p.kind === 'closeup');
    const missing = d.colours.filter((c) => !flats.some((f) => f.colour === c));
    if (!stale && missing.length === 0 && closeups.length > 0) { writeVer(d.id, d.version); return; }
    setPlainBusy(true); setPlainErr(null);
    try {
      if (stale) for (const p of live.filter((x) => x.kind === 'flat' || x.kind === 'closeup')) await updatePhoto(d.id, p.id, { status: 'removed' });
      const [comp, pf] = await Promise.all([import('../../../lib/composite'), import('../../../lib/printFile')]);
      const bmp = await pf.loadBitmap(d.print_url);
      const area = areaFor(d.placement.kind, d.placement.side);
      const todo = stale ? d.colours : missing;
      for (const c of todo) {
        const blob = await comp.flatShirtPicture(bmp, d.placement, { w: area.w, h: area.h }, hexForColour(c, fits));
        await uploadPhoto(d.id, blob, `plain-${c}-v${d.version}.webp`, 'flat', c);
      }
      if (stale || closeups.length === 0) {
        const c0 = d.colours[0];
        await uploadPhoto(d.id, await comp.printCloseup(bmp, hexForColour(c0, fits)), `closeup-v${d.version}.webp`, 'closeup', c0);
      }
      bmp.close();
      writeVer(d.id, d.version);
      await reload();
    } catch (e) {
      captureException(e, { where: 'studio_plain_pictures' });
      setPlainErr(errMessage(e, 'Could not make the plain-shirt pictures.'));
    } finally { setPlainBusy(false); }
  }, [fits, reload]);

  useEffect(() => {
    if (!design || !fits || plainRan.current) return;
    plainRan.current = true;
    void makePlain(design);
  }, [design, fits, makePlain]);

  if (error && !design) return <Page><LoadError message={error} onRetry={() => void reload()} /></Page>;
  if (!design) return <Page><Loading what="Opening your photos…" /></Page>;

  const models = sortModels(design.photos);
  const plain = design.photos.filter((p) => (p.kind === 'flat' || p.kind === 'closeup') && p.status === 'kept');
  const coverage = design.photo_coverage.length
    ? design.photo_coverage
    : colours.map((c) => ({ colour: c, photos: models.filter((p) => p.colour === c).length }));

  const addFiles = async (list: FileList | File[] | null): Promise<void> => {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    const errs: string[] = [];
    for (const f of files) {
      if (!OK_TYPES.includes(f.type)) { errs.push(`${f.name}: use a JPG, PNG or WebP photo.`); continue; }
      if (f.size > PRINT_SPECS.max_upload_bytes) { errs.push(`${f.name}: larger than 15 MB.`); continue; }
      setBusy(`Uploading ${f.name}…`);
      try {
        const p = await uploadPhoto(design.id, f, f.name, 'model', colours[0] ?? '');
        capture('studio_photo_uploaded', { kind: 'model', size_ok: p.checks.size_ok !== false });
      } catch (e) {
        captureException(e, { where: 'studio_photo_upload' });
        errs.push(`${f.name}: ${errMessage(e, 'could not upload.')}`);
      }
    }
    setBusy(null); setProblems(errs);
    await reload();
  };

  const patch = async (p: StudioPhoto, body: Parameters<typeof updatePhoto>[2], okMsg?: string): Promise<void> => {
    try { await updatePhoto(design.id, p.id, body); await reload(); if (okMsg) toast.success(okMsg); } catch (e) {
      captureException(e, { where: 'studio_photo_update' });
      toast.error(errMessage(e, 'Could not change that photo.'));
    }
  };

  const drop = async (target: StudioPhoto): Promise<void> => {
    const from = models.findIndex((m) => m.id === dragId);
    const to = models.findIndex((m) => m.id === target.id);
    setDragId(null); setOverId(null);
    if (from < 0 || to < 0 || from === to) return;
    const order = [...models];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    try {
      for (let i = 0; i < order.length; i++) if (order[i].sort !== i || order[i].id === moved.id) await updatePhoto(design.id, order[i].id, { sort: i });
      await reload();
    } catch (e) {
      captureException(e, { where: 'studio_photo_reorder' });
      toast.error(errMessage(e, 'Could not reorder the photos.'));
    }
  };

  const next = async (): Promise<void> => {
    setBusy('One moment…');
    try { await advanceTo(design, 'publish'); go(stepHref(design.id, 'publish')); } catch (e) {
      captureException(e, { where: 'studio_photos_next' });
      toast.error(errMessage(e, 'Could not move on.'));
      setBusy(null);
    }
  };

  return (
    <Page>
      <TopBar design={design} />
      <Steps id={design.id} current="photos" design={design} />
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
      <div className="g2">
        <div className="panel"><h2>Upload your photos</h2>
          <p className="lead">Photos of people wearing this design. JPG or PNG, at least 1200 px on the short side.</p>
          <div className={`ph drop${over ? ' over' : ''}${busy ? ' busy' : ''}`} style={{ height: 150, borderStyle: 'dashed' }} role="button" tabIndex={0}
            onClick={() => fileRef.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click(); }}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); void addFiles(e.dataTransfer.files); }}>
            <span>{busy ?? <>Drop photos here or <b style={{ textDecoration: 'underline' }}>choose files</b></>}</span>
          </div>
          {problems.map((m) => <p key={m} className="errtxt" role="alert">{m}</p>)}
        </div>
        <div className="panel"><h2>Every colour you sell has a photo?</h2>
          {coverage.length === 0 ? <p className="lead" style={{ margin: 0 }}>Choose the colours you sell in Step 2 and they are checked here.</p> : (
            <ul className="list">
              {coverage.map((c) => (
                <li key={c.colour}>
                  <span className={`dot ${c.photos > 0 ? 'ok' : 'warn'}`}>{c.photos > 0 ? '✓' : '!'}</span>
                  <div><b>{c.colour}</b> · {c.photos > 0 ? `${c.photos} photo${c.photos === 1 ? '' : 's'}` : 'no photo — the plain-shirt picture will be shown for it'}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="foot" style={{ margin: '0 0 12px' }}><h2>Your photos</h2><span className="chip info">Drag to reorder · first is the shop card picture</span></div>
        {models.length === 0 ? <p className="lead" style={{ margin: 0 }}>No photos yet. Add the ones you made above.</p> : (
          <div className="g4">
            {models.map((p, i) => {
              const hex = p.colour ? hexForColour(p.colour, fits) : '#d9bd8c';
              const colourBad = p.checks.colour_sold === false;
              const sizeBad = p.checks.size_ok === false;
              const main = i === 0;
              return (
                <div key={p.id} className={`card${main ? ' sel' : ''}${overId === p.id && dragId !== p.id ? ' drag-over' : ''}`} draggable
                  onDragStart={() => setDragId(p.id)} onDragEnd={() => { setDragId(null); setOverId(null); }}
                  onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverId(p.id); } }} onDrop={(e) => { e.preventDefault(); void drop(p); }}>
                  <img className="tee-img" src={p.url} alt={`Model photo${p.colour ? `, ${p.colour} shirt` : ''}`} loading="lazy" style={{ background: hex, borderColor: hex }} />
                  <label className="lbl">Shirt colour in this photo
                    <select className="fld" value={p.colour ?? ''} onChange={(e) => void patch(p, { colour: e.target.value })}>
                      {!p.colour && <option value="">Choose…</option>}
                      {colours.includes(p.colour ?? '') || !p.colour ? null : <option value={p.colour ?? ''}>{p.colour}</option>}
                      {colours.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                  <div className="row">
                    {colourBad ? <span className="chip bad">{p.colour} is not ticked for this product</span>
                      : p.colour ? <span className="chip ok">Tagged {p.colour} ✓</span> : <span className="chip warn">Pick the shirt colour</span>}
                    {sizeBad ? <span className="chip warn">Small: {p.width} × {p.height} px — may look soft on big screens</span>
                      : <span className="chip">{p.width && p.height ? `${p.width} × ${p.height} px ✓` : 'Size not read'}</span>}
                  </div>
                  <div className="row">
                    <button className={`btn sm ${main ? 'teal' : 'ghost'}`} type="button" disabled={main || p.is_main} onClick={() => void patch(p, { is_main: true }, 'Main photo changed.')}>{main ? 'Main photo' : 'Set as main'}</button>
                    <button className="btn ghost sm" type="button" onClick={() => void patch(p, { status: 'removed' }, 'Photo removed.')}>Remove</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p style={{ font: '600 14px/1.5 Nunito', color: '#6b4a2b', margin: '12px 0 0' }}>Your photos are for the shop page only. What gets printed is always the print file from Step 3 — never anything taken from these photos.</p>
      </div>

      <div className="panel">
        <div className="foot" style={{ margin: '0 0 12px' }}><h2>Plain shirt pictures</h2>
          <span className={`chip ${plainErr ? 'bad' : plainBusy ? 'warn' : 'ok'}`}>{plainErr ?? (plainBusy ? 'Making them from your design…' : 'Made automatically from your design')}</span></div>
        {plain.length === 0 ? <p className="lead" style={{ margin: 0 }}>{plainBusy ? 'One moment…' : design.print_url ? 'They appear here once made.' : 'Finish Step 3 and they are made from your print file.'}</p> : (
          <div className="g4">
            {plain.map((p) => (
              <div className="card" key={p.id}>
                <img className="thumb-img" src={p.url} alt={p.kind === 'closeup' ? 'Print close-up' : `Plain shirt, ${p.colour ?? ''}`} loading="lazy" style={{ height: 170 }} />
                <span className="chip">{p.kind === 'closeup' ? 'Close-up' : p.colour}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="foot">
        <a className="btn ghost" href={stepHref(design.id, 'design')}>Back</a>
        <button type="button" className="btn red" disabled={!!busy || plainBusy} onClick={() => void next()}>Name, price and publish →</button>
      </div>
    </Page>
  );
}
