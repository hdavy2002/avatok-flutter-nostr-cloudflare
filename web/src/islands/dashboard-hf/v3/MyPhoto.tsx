/* [HF-MOD-WEB-PHOTOS] "My photo & cover": a fan picks a profile photo and a cover. The browser shrinks it (profile = square up to 1080,
 * cover = up to 1600 wide, JPEG 0.8), the worker answers 202 and an AI safety check runs in the background. Until the new picture passes,
 * the old one stays. Worker: PUT /api/hf/me/photo, PUT /api/hf/me/cover, GET /api/hf/me/photos. Switch: hfPhotoModerationEnabled.
 * Look: the approved artboard (Nunito headings, Comfortaa body, solid plum buttons, lavender + gold panels, no green). */
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import type { DashboardAccount } from '../../../components/account/DashboardNav';
import { capture } from '../../../lib/analytics';
import { LIMITS, getMyPhotos, putMyImage, shrinkImage, type MyPhotos, type PhotoKind } from '../../../lib/hfPhotosApi';
import '../../../styles/hf-my-photo.css';
import { Avatar, Ic, Marigold, PageHead, Skel, useToast } from './ui';
import { useDash } from './data';

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const POLL_MS = 2000, POLL_MAX_MS = 60_000;

type Phase = 'sending' | 'checking' | 'passed' | 'refused' | 'slow';
interface Job { kind: PhotoKind; phase: Phase; preview: string | null; message: string }

const KIND_LABEL: Record<PhotoKind, string> = { profile: 'photo', cover: 'cover' };

function uploadMessage(error: string, fallback: string): string {
  if (error === 'too_big') return 'That picture is bigger than 4 MB. Please choose a smaller one.';
  if (error === 'too_small') return 'That picture is too small. Please choose a bigger one.';
  if (error === 'bad_type') return 'That file type is not supported. Please use a JPEG, PNG or WebP picture.';
  if (error === 'empty') return 'That file looks empty. Please choose another picture.';
  return fallback;
}

export default function MyPhoto({ account }: { account: DashboardAccount }) {
  const toast = useToast();
  const { profile } = useDash();
  const [photos, setPhotos] = useState<MyPhotos | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [over, setOver] = useState(false);
  const photoIn = useRef<HTMLInputElement>(null);
  const coverIn = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const run = useRef(0);
  const objUrl = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const p = await getMyPhotos();
    if (!alive.current) return null;
    if (p) { setPhotos(p); setLoadFailed(false); } else setLoadFailed(true);
    return p;
  }, []);

  /** Polls every 2 s for up to 60 s until the slot is no longer being checked. */
  const poll = useCallback(async (kind: PhotoKind, id: number, startedAt: number, prevUrl: string | null) => {
    while (alive.current && id === run.current) {
      if (Date.now() - startedAt > POLL_MAX_MS) { setJob(j => (j && j.kind === kind ? { ...j, phase: 'slow' } : j)); capture('hf_photo_result_web', { kind, result: 'timeout' }); return; }
      await new Promise(r => setTimeout(r, POLL_MS));
      if (!alive.current || id !== run.current) return;
      const p = await refresh();
      if (!p) continue;
      const s = p[kind];
      if (s.checking) continue;
      if (s.refused) { setJob(j => (j && j.kind === kind ? { ...j, phase: 'refused', message: s.refused ?? '' } : j)); capture('hf_photo_result_web', { kind, result: 'refused' }); return; }
      if (s.url && s.url !== prevUrl) { setJob(j => (j && j.kind === kind ? { ...j, phase: 'passed' } : j)); capture('hf_photo_result_web', { kind, result: 'passed' }); toast(`Your new ${KIND_LABEL[kind]} is live ✓`); return; }
    }
  }, [refresh, toast]);

  useEffect(() => {
    alive.current = true;
    void refresh().then(p => {
      if (!p || !alive.current) return;
      (['profile', 'cover'] as PhotoKind[]).forEach(kind => {
        const s = p[kind];
        if (s.checking) { const id = ++run.current; setJob({ kind, phase: 'checking', preview: s.url, message: '' }); void poll(kind, id, Date.now(), s.url); }
      });
    });
    return () => { alive.current = false; run.current++; if (objUrl.current) URL.revokeObjectURL(objUrl.current); };
  }, [refresh, poll]);

  const pick = useCallback(async (file: File | null | undefined, kind: PhotoKind) => {
    if (!file) return;
    const id = ++run.current;
    const fail = (message: string, error: string, bytes = 0, ms = 0) => {
      setJob({ kind, phase: 'refused', preview: null, message });
      capture('hf_photo_upload_web', { kind, bytes, ms, ok: false, error });
    };
    if (!TYPES.includes(file.type)) { fail('That file type is not supported. Please use a JPEG, PNG or WebP picture.', 'bad_type'); return; }
    const t0 = performance.now();
    setJob({ kind, phase: 'sending', preview: null, message: '' });
    const out = await shrinkImage(file, kind);
    if (!alive.current || id !== run.current) return;
    if (!out) { fail('We could not read that picture. Please try another one.', 'decode'); return; }
    const [minW, minH] = kind === 'profile' ? LIMITS.profileMin : LIMITS.coverMin;
    if (out.width < minW || out.height < minH) { fail(`That picture is too small. Please use one at least ${minW} × ${minH} pixels.`, 'too_small', out.blob.size); return; }
    if (out.blob.size > LIMITS.maxBytes) { fail('That picture is bigger than 4 MB. Please choose a smaller one.', 'too_big', out.blob.size); return; }
    if (objUrl.current) URL.revokeObjectURL(objUrl.current);
    objUrl.current = URL.createObjectURL(out.blob);
    setJob({ kind, phase: 'sending', preview: objUrl.current, message: '' });
    const prevUrl = photos?.[kind].url ?? null;
    const r = await putMyImage(kind, out.blob);
    const ms = Math.round(performance.now() - t0);
    if (!alive.current || id !== run.current) return;
    if (!r.ok) {
      setJob({ kind, phase: 'refused', preview: null, message: uploadMessage(r.error, r.message) });
      capture('hf_photo_upload_web', { kind, bytes: out.blob.size, ms, ok: false, error: r.error });
      return;
    }
    capture('hf_photo_upload_web', { kind, bytes: out.blob.size, ms, ok: true, error: '' });
    setJob({ kind, phase: 'checking', preview: objUrl.current, message: '' });
    void poll(kind, id, Date.now(), prevUrl);
  }, [photos, poll]);

  const onDrop = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setOver(false); void pick(e.dataTransfer.files?.[0], 'profile'); };

  const locked = account.closing;
  const name = profile.data?.displayName || account.displayName || 'Your name';
  const handle = profile.data?.username || null;
  const profileUrl = photos?.profile.url ?? null;
  const coverUrl = photos?.cover.url ?? null;
  const busy = job?.phase === 'sending' || job?.phase === 'checking';
  const jobLabel = job ? (job.kind === 'profile' ? 'photo' : 'cover') : 'photo';

  return <div className="mp">
    <PageHead eyebrow="Dashboard · Profile" title="My photo & cover" sub="Your photo shows next to your comments and bookings. Every new photo is checked for safety in a few seconds before anyone sees it." />

    {!photos && !loadFailed ? <Skel h={340} /> : <section className="mp-hero" aria-label="Preview">
      <div className="mp-cover">
        {coverUrl ? <img src={coverUrl} alt="" /> : <CoverArt />}
        <button type="button" className="mp-coverbtn" disabled={locked || busy} onClick={() => coverIn.current?.click()}><Ic name="plus" className="" size={20} />Change cover</button>
      </div>
      <div className="mp-who">
        <div className="mp-av">{profileUrl ? <img src={profileUrl} alt="" /> : <Avatar name={name} seed={account.uid} size="lg" />}</div>
        <div className="mp-meta"><div className="mp-name">{name}</div>{handle && <div className="mp-handle">@{handle}</div>}</div>
      </div>
    </section>}
    {loadFailed && <div className="mp-alert" role="alert"><b>We could not load your photos.</b><p>Please check your internet. <button type="button" className="h3-link" onClick={() => void refresh()}>Try again</button></p></div>}

    <div className="mp-grid">
      <section className="mp-panel mp-lav" aria-label="New profile photo">
        <span className="mp-corner" aria-hidden="true"><Marigold size={86} /></span>
        <h2>New profile photo</h2>
        <div className={`mp-drop${over ? ' over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
          <b>Drag a photo here</b>
          <span>JPEG, PNG or WebP. We shrink it before upload.</span>
          <button type="button" className="mp-btn" disabled={locked || busy} onClick={() => photoIn.current?.click()}>Choose a photo</button>
        </div>

        {job && job.phase !== 'refused' && <div className="mp-status" role="status">
          <div className="mp-thumb">{job.preview ? <img src={job.preview} alt="" /> : <Skel h={64} />}</div>
          <div>
            {job.phase === 'passed' ? <span className="mp-chip">Your new {jobLabel} is live</span>
              : job.phase === 'slow' ? <span className="mp-chip">Still checking your new {jobLabel}…</span>
              : <span className="mp-chip">{job.phase === 'sending' ? `Sending your new ${jobLabel}…` : `Checking your new ${jobLabel}…`}</span>}
            <div className="mp-hint">{job.phase === 'passed' ? 'Everyone can see it now.' : job.phase === 'slow' ? 'This is taking longer than usual. Come back in a minute. Your old one stays until the new one passes.' : `Your old ${jobLabel} stays until this one passes.`}</div>
          </div>
        </div>}

        {job?.phase === 'refused' && <div className="mp-alert" role="alert">
          <span className="mp-x" aria-hidden="true"><Ic name="x" className="" size={18} /></span>
          <div><b>We couldn’t use that {jobLabel}</b><p>{job.message}</p>
            <button type="button" className="mp-btn" onClick={() => (job.kind === 'cover' ? coverIn : photoIn).current?.click()}>Choose another photo</button></div>
        </div>}
      </section>

      <section className="mp-panel mp-gold" aria-label="Photo rules">
        <span className="mp-corner" aria-hidden="true"><Marigold size={86} tone={1} /></span>
        <h2>What’s allowed</h2>
        <ul className="mp-rules">
          <li>Your face, a pet, a place you love: all fine.</li>
          <li>No nudity or sexual content.</li>
          <li>No violence, blood or injury.</li>
          <li>Cover: a wide picture works best (at least 640 × 200).</li>
        </ul>
        <p className="mp-hint">If a photo is refused, it is deleted straight away and nobody sees it.</p>
      </section>
    </div>

    <input ref={photoIn} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={e => { void pick(e.target.files?.[0], 'profile'); e.target.value = ''; }} />
    <input ref={coverIn} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={e => { void pick(e.target.files?.[0], 'cover'); e.target.value = ''; }} />
  </div>;
}

function CoverArt() {
  return <svg viewBox="0 0 1240 260" preserveAspectRatio="xMidYMid slice" width="100%" height="100%" aria-hidden="true">
    <rect width="1240" height="260" fill="#F59E0B" />
    <g fill="#D81B72"><circle cx="90" cy="60" r="40" /><circle cx="340" cy="190" r="52" /><circle cx="640" cy="50" r="34" /><circle cx="930" cy="180" r="56" /><circle cx="1180" cy="60" r="30" /></g>
    <g fill="#4A1747"><rect x="190" y="110" width="60" height="60" rx="12" transform="rotate(45 220 140)" /><rect x="780" y="90" width="50" height="50" rx="10" transform="rotate(45 805 115)" /></g>
    <g fill="#0E7C86"><circle cx="500" cy="140" r="22" /><circle cx="1070" cy="120" r="18" /></g>
    <g fill="#FFF1D6"><circle cx="90" cy="60" r="14" /><circle cx="340" cy="190" r="18" /><circle cx="930" cy="180" r="20" /></g>
  </svg>;
}
