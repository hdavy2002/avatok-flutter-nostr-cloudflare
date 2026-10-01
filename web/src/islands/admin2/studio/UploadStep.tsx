/* UploadStep — [AUMFE-POD-STUDIO-WEB-1 2026-10-01] Step 1, replica of Specs/studio-mockup/Upload.dc.html.
 * Pick/drop the artwork → checked IN THE BROWSER (artAnalysis.ts: alpha, trim, soft edges, dominant colours, CMYK→RGB)
 * → trimmed PNG + preview uploaded → "File check" list and "How big it can print sharply". Serves both
 * /admin/shop/studio/new (no id yet; the design is created on the first file) and /admin/shop/studio/<id>/upload. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../../../components/ui/sonner';
import { capture, captureException } from '../../../lib/analytics';
import {
  PRINT_SPECS, STEP_ORDER, areaFor, createDesign, errMessage, fetchArtBlob, fmtBytes, fmtIn, maxSharpInches, stepHref, updateDesign,
  uploadArt, uploadArtPreview, type Design, type StudioStep,
} from '../../../lib/studioApi';
import type { ArtAnalysis } from './artAnalysis';
import { LoadError, Loading, Page, Steps, TopBar, go, useDesign } from './StudioKit';

interface Info {
  w: number; h: number; bytes: number; mime: string; has_alpha: boolean | null; rgb: boolean | null;
  cmyk: boolean; soft: number; colours: string[];
}

const MIME_LABEL: Record<string, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPG' };
const SOFT_WARN_PCT = 2;

export async function advanceTo(design: Design | null, step: StudioStep): Promise<void> {
  if (!design) return;
  if (STEP_ORDER.indexOf(design.step) < STEP_ORDER.indexOf(step)) await updateDesign(design.id, { step });
}

export default function UploadStep({ designId }: { designId: string | null }) {
  const [id, setId] = useState<string | null>(designId);
  const { design, setDesign, error, reload } = useDesign(id);
  const [analysis, setAnalysis] = useState<ArtAnalysis | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const idRef = useRef<string | null>(designId);
  const designRef = useRef<Design | null>(null);
  designRef.current = design;

  useEffect(() => { capture('studio_viewed', { step: 'upload' }); }, []);
  useEffect(() => { if (design) setName((n) => n || design.name); }, [design]);
  useEffect(() => () => { if (analysis) URL.revokeObjectURL(analysis.previewUrl); }, [analysis]);

  const handleFile = useCallback(async (file: File) => {
    setProblem(null); setBusy('Checking your artwork…');
    try {
      const { analyseArtwork } = await import('./artAnalysis');
      const a = await analyseArtwork(file);
      setAnalysis(a);
      setBusy('Saving your artwork…');
      let did = idRef.current;
      if (!did) {
        const base = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Untitled design';
        const d = await createDesign(base.charAt(0).toUpperCase() + base.slice(1));
        did = d.id; idRef.current = d.id; setId(d.id); setName(d.name);
        window.history.replaceState(null, '', stepHref(d.id, 'upload'));
        capture('studio_design_created', {});
      }
      await uploadArt(did, a.blob, a.fileName);
      try { await uploadArtPreview(did, a.preview); } catch (e) { captureException(e, { where: 'studio_art_preview' }); }
      const saved = await updateDesign(did, {
        art_checks: { trimmed_px: a.trimmed_px, soft_edge_pct: a.soft_edge_pct, dominant_colours: a.dominant_colours, cmyk_converted: a.cmyk_converted },
      });
      setDesign(saved);
      capture('studio_art_uploaded', { w: a.w, h: a.h, has_alpha: a.has_alpha });
      void reload();
    } catch (e) {
      captureException(e, { where: 'studio_art_upload' });
      setProblem(errMessage(e, e instanceof Error && e.message ? e.message : 'Could not use that file.'));
    } finally { setBusy(null); }
  }, [reload, setDesign]);

  const makeSolid = useCallback(async () => {
    setBusy('Making the edges solid…'); setProblem(null);
    try {
      const { solidifyEdges } = await import('./artAnalysis');
      const src: Blob = analysis ? analysis.blob : await fetchArtBlob(design?.id ?? idRef.current ?? '');
      const f = await solidifyEdges(src, analysis?.fileName ?? design?.name ?? 'artwork');
      setBusy(null);
      await handleFile(f);
      toast.success('Edges are solid now.');
    } catch (e) {
      captureException(e, { where: 'studio_solid_edges' });
      setProblem(errMessage(e, 'Could not change the edges.'));
      setBusy(null);
    }
  }, [analysis, design, handleFile]);

  const saveName = useCallback(async () => {
    const d = designRef.current;
    const n = name.trim();
    if (!d || !n || n === d.name) return;
    try { setDesign(await updateDesign(d.id, { name: n })); } catch (e) {
      captureException(e, { where: 'studio_rename' });
      toast.error(errMessage(e, 'Could not save the name.'));
    }
  }, [name, setDesign]);

  const next = useCallback(async () => {
    if (!design) return;
    setBusy('One moment…');
    try { await advanceTo(design, 'product'); go(stepHref(design.id, 'product')); } catch (e) {
      captureException(e, { where: 'studio_upload_next' });
      setProblem(errMessage(e, 'Could not move on.'));
      setBusy(null);
    }
  }, [design]);

  if (designId && error && !design) return <Page><LoadError message={error} onRetry={() => void reload()} /></Page>;
  if (designId && !design) return <Page><Loading what="Opening your design…" /></Page>;

  const info: Info | null = analysis
    ? { w: analysis.w, h: analysis.h, bytes: analysis.bytes, mime: analysis.mime, has_alpha: analysis.has_alpha, rgb: true, cmyk: analysis.cmyk_converted, soft: analysis.soft_edge_pct, colours: analysis.dominant_colours }
    : design && design.art_w && design.art_h
      ? { w: design.art_w, h: design.art_h, bytes: design.art_bytes ?? 0, mime: design.art_mime ?? 'image/png', has_alpha: design.art_checks.has_alpha ?? null, rgb: design.art_checks.rgb ?? null, cmyk: !!design.art_checks.cmyk_converted, soft: design.art_checks.soft_edge_pct ?? 0, colours: design.art_checks.dominant_colours ?? [] }
      : null;
  const shown = analysis?.previewUrl ?? design?.art_preview_url ?? null;
  const sharp = info ? maxSharpInches(info.w, info.h) : null;
  const ref = areaFor('mens_tee', 'front');
  const fitsWhole = sharp ? sharp.w >= ref.w : false;
  const limitsOk = info ? info.w <= PRINT_SPECS.max_px && info.h <= PRINT_SPECS.max_px && info.bytes <= PRINT_SPECS.max_upload_bytes : true;

  const pick = (): void => fileRef.current?.click();
  const onFiles = (list: FileList | null): void => { const f = list?.[0]; if (f) void handleFile(f); };

  return (
    <Page>
      <TopBar design={design} />
      <Steps id={id} current="upload" design={design} />
      <input ref={fileRef} type="file" accept="image/png,image/jpeg" hidden onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
      <div className={`g2${busy ? ' busy' : ''}`} aria-busy={!!busy}>
        <div className="panel">
          <h2>Your artwork</h2>
          <p className="lead">Drop a 2000–5000 px image. Bigger files are fine; we resize to Printrove&apos;s limit.</p>
          {shown ? (
            <div className="ph chk" style={{ height: 420, borderStyle: 'solid', padding: 40 }}>
              <img src={shown} alt="Your artwork" style={{ maxWidth: '100%', maxHeight: 340, objectFit: 'contain', borderRadius: 12 }} />
            </div>
          ) : (
            <div className={`ph chk drop${over ? ' over' : ''}`} style={{ height: 420, borderStyle: 'dashed', padding: 40 }} role="button" tabIndex={0}
              onClick={pick} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') pick(); }}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files); }}>
              <span>Drop your artwork here or <b style={{ textDecoration: 'underline' }}>choose a file</b><br />PNG with a see-through background works best</span>
            </div>
          )}
          {busy && <p className="lead" style={{ margin: '12px 0 0' }} role="status">{busy}</p>}
          {problem && <p className="errtxt" role="alert">{problem}</p>}
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn ghost sm" type="button" onClick={pick}>{shown ? 'Replace file' : 'Choose file'}</button>
            <label className="lbl" style={{ flex: 1, minWidth: 240 }}>Name this design
              <input className="fld" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void saveName()} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} maxLength={120} />
            </label>
          </div>
        </div>
        <div>
          <div className="panel">
            <h2>File check</h2>
            {!info ? <p className="lead" style={{ margin: 0 }}>Choose your artwork and the checks appear here.</p> : (
              <ul className="list">
                <li><span className={`dot ${limitsOk ? 'ok' : 'warn'}`}>{limitsOk ? '✓' : '!'}</span><div><b>{info.w} × {info.h} px · {MIME_LABEL[info.mime] ?? 'Image'} · {fmtBytes(info.bytes)}</b><br />{limitsOk ? 'Under Printrove\'s 5000 × 5000 px and 15 MB limits.' : 'Over Printrove\'s limits — your print file is made smaller and stays under them.'}</div></li>
                {info.has_alpha === false
                  ? <li><span className="dot warn">!</span><div><b>No see-through background</b><br />A coloured or white box would print around your art. A PNG with a see-through background prints only the art.</div></li>
                  : <li><span className="dot ok">✓</span><div><b>See-through background</b><br />Only your art prints — no white box around it.</div></li>}
                <li><span className="dot ok">✓</span><div><b>{info.cmyk ? 'Converted from CMYK to RGB' : 'RGB colours'}</b><br />Printrove does not accept CMYK. A CMYK file would be converted for you.</div></li>
                <li><span className="dot ok">✓</span><div><b>Empty edges trimmed</b><br />Printrove trims see-through edges itself, so we trim first and your placement stays exact.</div></li>
                {info.soft >= SOFT_WARN_PCT && (
                  <li><span className="dot warn">!</span><div><b>Soft, see-through glow at the edges</b><br />Half-see-through pixels can print patchy on fabric. <a href="#solid" onClick={(e) => { e.preventDefault(); void makeSolid(); }}>Make edges solid</a></div></li>
                )}
              </ul>
            )}
          </div>
          <div className="panel">
            <h2>How big it can print sharply</h2>
            {!sharp ? <p className="lead" style={{ margin: 0 }}>Shown once your artwork is checked.</p> : (
              <p style={{ font: '700 16px/1.6 Nunito', color: '#3c4a4c', margin: 0 }}>
                At 300 DPI (Printrove&apos;s minimum) this file prints sharp up to <b style={{ color: '#5a1f14' }}>{fmtIn(sharp.w)} × {fmtIn(sharp.h)} in</b>.<br />
                A full {ref.label.replace("Men's T-shirt", "men's tee")} front is {fmtIn(ref.w)} × {fmtIn(ref.h)} in, so this art {fitsWhole ? 'can fill the whole print area.' : 'suits a chest or centre print, not edge-to-edge.'}
              </p>
            )}
          </div>
          <div className="foot"><span></span>
            <button type="button" className="btn red" disabled={!design || !info || !!busy} onClick={() => void next()}>See which products it suits →</button>
          </div>
        </div>
      </div>
    </Page>
  );
}
