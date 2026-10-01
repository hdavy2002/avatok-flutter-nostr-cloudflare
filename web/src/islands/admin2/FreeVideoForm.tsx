/* FreeVideoForm — [SAATHUM-FREEVIDEOS-ADMIN-1 2026-10-01] /admin/free-videos/new and /[id].
 * Contract: Specs/SPEC-2026-10-01-FREE-VIDEOS.md ("Web — admin"). API: worker/src/routes/free_videos.ts.
 *
 *  - Details (title, description, category chips), Cover photo (upload, or "Use the YouTube
 *    thumbnail" = cover_url null), YouTube video + crop (VideoCropEditor), live card preview.
 *  - Save draft / Publish / Archive. Server validation errors are shown, never swallowed.
 *  - Telemetry: admin2_free_video_saved {id, status}; failures -> captureException.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Archive, CircleAlert, ExternalLink, ImagePlus, Loader2, Save, Send, Upload } from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { toast } from '../../components/ui/sonner';
import { ErrorState, Shimmer, youtubeThumb } from '../../components/dash2/shared';
import type { VideoCrop } from '../../components/dash2/crop';
import VideoCropEditor from './VideoCropEditor';
import { ApiError, errMessage } from './adminApi';
import { looksLikeYoutube, uploadCover, youtubeIdOf } from './eventsApi';
import {
  FREE_VIDEO_CATEGORIES, FREE_VIDEO_LIMITS, archiveFreeVideo, categoryLabel, createFreeVideo, freeStatusMeta, getFreeVideo,
  updateFreeVideo, type FreeVideoBody, type FreeVideoRow, type FreeVideoStatus,
} from './freeVideosApi';

interface FormState {
  title: string;
  description: string;
  category: string;
  /** null = use the YouTube thumbnail. */
  cover_url: string | null;
  youtube_url: string;
  crop: VideoCrop | null;
}
const EMPTY: FormState = { title: '', description: '', category: 'satsang', cover_url: null, youtube_url: '', crop: null };

function fromRow(v: FreeVideoRow): FormState {
  return {
    title: v.title, description: v.description ?? '', category: v.category, cover_url: v.cover_url,
    youtube_url: v.youtube_url || (v.youtube_video_id ? `https://youtu.be/${v.youtube_video_id}` : ''), crop: v.crop ?? null,
  };
}
const sameCrop = (a: VideoCrop | null, b: VideoCrop | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

export default function FreeVideoForm({ videoId }: { videoId?: string }) {
  const [id, setId] = useState<string | undefined>(videoId);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [base, setBase] = useState<FormState | null>(null);
  const [status, setStatus] = useState<FreeVideoStatus>('draft');
  const [loading, setLoading] = useState(!!videoId);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'draft' | 'publish' | 'archive' | 'upload'>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const apply = useCallback((v: FreeVideoRow) => {
    const f = fromRow(v);
    setForm(f); setBase(f); setStatus(v.status); setId(v.id);
  }, []);

  const load = useCallback(async (vid: string) => {
    setLoading(true); setLoadError(null);
    try {
      apply((await getFreeVideo(vid)).video);
    } catch (e) {
      captureException(e, { where: 'admin2_free_video_load' });
      setLoadError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => { if (videoId) void load(videoId); }, [videoId, load]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const ytId = useMemo(() => youtubeIdOf(form.youtube_url), [form.youtube_url]);
  const archived = status === 'archived';
  const disabled = busy !== null || archived;
  const dirty = !base
    ? true
    : form.title !== base.title || form.description !== base.description || form.category !== base.category
      || form.cover_url !== base.cover_url || form.youtube_url !== base.youtube_url || !sameCrop(form.crop, base.crop);

  function validate(): boolean {
    const e: Partial<Record<keyof FormState, string>> = {};
    const t = form.title.trim();
    if (t.length < FREE_VIDEO_LIMITS.titleMin) e.title = `Title needs at least ${FREE_VIDEO_LIMITS.titleMin} characters.`;
    if (t.length > FREE_VIDEO_LIMITS.titleMax) e.title = `Keep the title under ${FREE_VIDEO_LIMITS.titleMax} characters.`;
    if (form.description.length > FREE_VIDEO_LIMITS.descriptionMax) e.description = `Keep the description under ${FREE_VIDEO_LIMITS.descriptionMax} characters.`;
    if (!form.youtube_url.trim()) e.youtube_url = 'Paste the YouTube link.';
    else if (!looksLikeYoutube(form.youtube_url) || !ytId) e.youtube_url = 'That does not look like a YouTube link.';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function body(next: FreeVideoStatus): FreeVideoBody {
    const b: FreeVideoBody = {};
    const all = !id || !base;
    if (all || form.title !== base!.title) b.title = form.title.trim();
    if (all || form.description !== base!.description) b.description = form.description.trim();
    if (all || form.category !== base!.category) b.category = form.category;
    if (all ? form.cover_url !== null : form.cover_url !== base!.cover_url) b.cover_url = form.cover_url;
    if (all || form.youtube_url !== base!.youtube_url) b.youtube_url = form.youtube_url.trim();
    if (all ? form.crop !== null : !sameCrop(form.crop, base!.crop)) b.crop = form.crop;
    if (all || next !== status) b.status = next;
    return b;
  }

  async function save(next: FreeVideoStatus) {
    setBanner(null);
    if (!validate()) { setBanner('Fix the highlighted fields first.'); return; }
    setBusy(next === 'published' ? 'publish' : 'draft');
    try {
      const r = id ? await updateFreeVideo(id, body(next)) : await createFreeVideo(body(next));
      apply(r.video);
      capture('admin2_free_video_saved', { id: r.video.id, status: r.video.status });
      toast.success(next === 'published' ? 'Published' : 'Saved');
      if (!id) window.history.replaceState(null, '', `/admin/free-videos/${encodeURIComponent(r.video.id)}`);
    } catch (e) {
      captureException(e, { where: 'admin2_free_video_save', status: next });
      const msg = errMessage(e);
      setBanner(msg);
      if (e instanceof ApiError && /youtube/i.test(`${e.error} ${msg}`)) setErrors((x) => ({ ...x, youtube_url: msg }));
    } finally {
      setBusy(null);
    }
  }

  async function onArchive() {
    if (!id) return;
    setBusy('archive');
    try {
      await archiveFreeVideo(id);
      capture('admin2_free_video_saved', { id, status: 'archived' });
      toast.success('Archived');
      window.location.assign('/admin/free-videos');
    } catch (e) {
      captureException(e, { where: 'admin2_free_video_archive' });
      setBanner(errMessage(e));
      setBusy(null);
    } finally {
      setConfirmArchive(false);
    }
  }

  async function onUpload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setBusy('upload');
    try {
      set('cover_url', await uploadCover(file));
      toast.success('Image uploaded', { description: 'Save to keep it.' });
      capture('admin2_free_video_cover_upload', { ok: true });
    } catch (e) {
      const msg = e instanceof Error && !(e instanceof ApiError) ? e.message : errMessage(e);
      setErrors((x) => ({ ...x, cover_url: msg }));
      captureException(e, { where: 'admin2_free_video_cover_upload' });
      capture('admin2_free_video_cover_upload', { ok: false });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  if (loadError) return <ErrorState message={loadError} onRetry={() => videoId && void load(videoId)} />;
  if (loading) {
    return (
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]" aria-busy="true">
        <Shimmer className="h-96 w-full rounded-xl" />
        <Shimmer className="h-72 w-full rounded-xl" />
      </div>
    );
  }

  const st = freeStatusMeta(status);
  const previewImg = form.cover_url || (ytId ? youtubeThumb(ytId) : null);
  const descLeft = FREE_VIDEO_LIMITS.descriptionMax - form.description.length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm"><a href="/admin/free-videos"><ArrowLeft /> All free videos</a></Button>
        {id && <Badge variant={st.variant}>{st.label}</Badge>}
      </div>

      {banner && (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-[14px] font-semibold text-destructive">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />{banner}
        </p>
      )}
      {archived && (
        <p className="rounded-xl border border-border bg-muted px-4 py-3 text-[14px] font-semibold text-muted-foreground">This video is archived. It can't be edited.</p>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-5">
          <Section title="Details" subtitle="Shown on the card and on the watch page.">
            <Field label="Title" htmlFor="fv-title" error={errors.title} hint={`${form.title.length}/${FREE_VIDEO_LIMITS.titleMax}`}>
              <Input id="fv-title" value={form.title} disabled={disabled} maxLength={FREE_VIDEO_LIMITS.titleMax + 20}
                onChange={(e) => set('title', e.target.value)} aria-invalid={!!errors.title} />
            </Field>
            <Field label="Description" htmlFor="fv-desc" error={errors.description} hint={`${descLeft} left`}>
              <textarea id="fv-desc" rows={4} value={form.description} disabled={disabled}
                maxLength={FREE_VIDEO_LIMITS.descriptionMax + 50} onChange={(e) => set('description', e.target.value)} aria-invalid={!!errors.description}
                className="flex min-h-[110px] w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm" />
            </Field>
            <div className="flex flex-col gap-1.5">
              <Label className="font-bold" id="fv-cat-label">Category</Label>
              <div role="radiogroup" aria-labelledby="fv-cat-label" className="flex flex-wrap gap-2">
                {FREE_VIDEO_CATEGORIES.map((c) => {
                  const on = form.category === c.id;
                  return (
                    <button key={c.id} type="button" role="radio" aria-checked={on} disabled={disabled}
                      onClick={() => set('category', c.id)}
                      className={cn('h-10 rounded-full border px-4 text-[14px] font-bold transition-colors disabled:opacity-60',
                        on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-foreground hover:bg-muted')}>
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </Section>

          <Section title="Cover photo" subtitle="Optional. Without one, the card uses the YouTube thumbnail.">
            <div className="flex flex-wrap items-center gap-3">
              <div className="aspect-[4/3] w-40 overflow-hidden rounded-lg border border-border/70 bg-muted">
                {previewImg
                  ? <img src={previewImg} alt="Cover preview" className="h-full w-full object-cover" />
                  : <span className="flex h-full w-full items-center justify-center px-2 text-center text-[12px] font-bold text-muted-foreground">No image yet</span>}
              </div>
              <div className="flex flex-col items-start gap-2">
                <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" id="fv-cover-file"
                  disabled={disabled} onChange={(e) => void onUpload(e.target.files)} />
                <Button type="button" variant="outline" disabled={disabled} onClick={() => fileRef.current?.click()}>
                  {busy === 'upload' ? <Loader2 className="animate-spin" /> : <Upload />} {form.cover_url ? 'Replace photo' : 'Upload a photo'}
                </Button>
                <Button type="button" variant={form.cover_url === null ? 'secondary' : 'ghost'} disabled={disabled || form.cover_url === null}
                  onClick={() => set('cover_url', null)}>
                  <ImagePlus /> Use the YouTube thumbnail
                </Button>
              </div>
            </div>
            {errors.cover_url && <p className="text-[13px] font-semibold text-destructive" role="alert">{errors.cover_url}</p>}
          </Section>

          <Section title="YouTube video" subtitle="Paste an unlisted YouTube link. Only signed-in visitors can watch, and the link is never shown on the page.">
            <Field label="YouTube link" htmlFor="fv-yt" error={errors.youtube_url}>
              <Input id="fv-yt" inputMode="url" value={form.youtube_url} disabled={disabled}
                onChange={(e) => set('youtube_url', e.target.value)} placeholder="https://youtube.com/watch?v=…" aria-invalid={!!errors.youtube_url} />
            </Field>
            {ytId && (
              <VideoCropEditor videoId={ytId} title={form.title} disabled={disabled}
                value={form.crop} saved={base?.crop ?? null} onChange={(c) => set('crop', c)} />
            )}
          </Section>
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-6">
          <div className="dash-surface rounded-xl border border-border/70 bg-card p-4">
            <h2 className="font-dash text-[17px] font-bold text-grand-teal">Card preview</h2>
            <article className="mt-3 overflow-hidden rounded-xl border border-border/70 bg-background">
              <div className="relative aspect-[4/3] bg-muted">
                {previewImg && <img src={previewImg} alt="" className="h-full w-full object-cover" />}
                <span className="absolute left-2 top-2 rounded-full bg-background/95 px-2.5 py-1 text-[12px] font-bold text-foreground shadow-sm">{categoryLabel(form.category)}</span>
                <span className="absolute right-2 top-2 rounded-full bg-accent px-2.5 py-1 text-[12px] font-bold text-accent-foreground shadow-sm">Free video</span>
              </div>
              <div className="flex flex-col gap-2 p-3">
                <h3 className="font-dash text-[17px] font-bold leading-snug text-grand-teal">{form.title.trim() || 'Your title appears here'}</h3>
                <p className="line-clamp-3 text-[14px] font-semibold text-muted-foreground">{form.description.trim() || 'A short description appears here.'}</p>
                <span className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-4 text-[14px] font-bold text-primary-foreground">Watch free →</span>
              </div>
            </article>
          </div>

          <div className="dash-surface flex flex-col gap-2 rounded-xl border border-border/70 bg-card p-4">
            <Button type="button" variant="outline" disabled={disabled || !dirty && status === 'draft' && !!id} onClick={() => void save(status === 'published' ? 'published' : 'draft')}>
              {busy === 'draft' ? <Loader2 className="animate-spin" /> : <Save />} {status === 'published' ? 'Save changes' : 'Save draft'}
            </Button>
            {status !== 'published' && (
              <Button type="button" disabled={disabled} onClick={() => void save('published')}>
                {busy === 'publish' ? <Loader2 className="animate-spin" /> : <Send />} Publish
              </Button>
            )}
            {status === 'published' && id && (
              <Button asChild variant="ghost"><a href={`/watch/${encodeURIComponent(id)}`} target="_blank" rel="noopener"><ExternalLink /> View on site</a></Button>
            )}
            {id && !archived && (
              <Button type="button" variant="ghost" className="text-destructive" disabled={busy !== null} onClick={() => setConfirmArchive(true)}>
                {busy === 'archive' ? <Loader2 className="animate-spin" /> : <Archive />} Archive
              </Button>
            )}
          </div>
        </aside>
      </div>

      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this video?</AlertDialogTitle>
            <AlertDialogDescription>It disappears from the site straight away. It can't be edited afterwards.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onArchive()}>Archive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="dash-surface flex flex-col gap-4 rounded-xl border border-border/70 bg-card p-4 sm:p-5">
      <header>
        <h2 className="font-dash text-[18px] font-bold text-grand-teal">{title}</h2>
        {subtitle && <p className="mt-1 text-[13px] font-semibold text-muted-foreground">{subtitle}</p>}
      </header>
      {children}
    </section>
  );
}

function Field({ label, htmlFor, error, hint, children }: { label: string; htmlFor?: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={htmlFor} className="font-bold">{label}</Label>
        {hint && !error && <span className="text-[12px] font-semibold text-muted-foreground">{hint}</span>}
      </div>
      {children}
      {error && <p className="text-[13px] font-semibold text-destructive" role="alert">{error}</p>}
    </div>
  );
}
