/* [HF-MERCH-STUDIO-2] One picture upload (check, trim, send to /art) shared by the Start step, the AI panel and the "add a picture" dialog. */
import { captureException } from '../../../lib/analytics';
import { uploadArt } from './api';
import type { StudioArt } from './studio/types';

export const MAX_ART_BYTES = 15 * 1024 * 1024;
export const MIN_ART_PX = 300;
export type UploadOutcome = { ok: true; art: StudioArt } | { ok: false; message: string };

export async function uploadArtFile(file: File, step: string): Promise<UploadOutcome> {
  let previewUrl = '';
  try {
    if (!/^image\/(png|jpeg)$/.test(file.type)) return { ok: false, message: `${file.name}: please use a PNG or JPG picture.` };
    const { analyseArtwork } = await import('../../admin2/studio/artAnalysis');
    const a = await analyseArtwork(file);
    previewUrl = a.previewUrl;
    if (a.w < MIN_ART_PX || a.h < MIN_ART_PX) throw new Error(`${file.name} is too small to print well. Use one that is at least ${MIN_ART_PX} × ${MIN_ART_PX} pixels.`);
    if (a.bytes > MAX_ART_BYTES) throw new Error(`${file.name} is bigger than 15 MB. Please save a smaller copy.`);
    const r = await uploadArt(a.blob, a.fileName);
    if (!r.ok) {
      if (r.status >= 500 || r.status === 0) captureException(new Error(`merch_art_${r.status}_${r.code}`), { area: 'hf_merch_creator', step });
      URL.revokeObjectURL(previewUrl);
      return { ok: false, message: r.message || 'Upload failed.' };
    }
    const warnings = [...r.data.checks.warnings];
    if (a.soft_edge_pct > 25) warnings.push('Edges look soft. It may print a little fuzzy.');
    return { ok: true, art: { ...r.data, checks: { ...r.data.checks, warnings }, localUrl: previewUrl, source: 'upload', label: file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 40) } };
  } catch (e) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    captureException(e, { area: 'hf_merch_creator', step });
    return { ok: false, message: e instanceof Error && e.message ? e.message : `We could not read ${file.name}.` };
  }
}

/** Uploads files one after another; reports each finished picture and the problems. */
export async function uploadMany(files: File[], step: string, onArt: (a: StudioArt) => void): Promise<string[]> {
  const problems: string[] = [];
  for (const f of files) {
    const o = await uploadArtFile(f, step);
    if (o.ok) onArt(o.art); else problems.push(o.message);
  }
  return problems;
}

export const artSrc = (a: { localUrl?: string; url: string }): string => a.localUrl ?? a.url;
