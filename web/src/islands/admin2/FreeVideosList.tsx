/* FreeVideosList — [SAATHUM-FREEVIDEOS-ADMIN-1 2026-10-01] /admin/free-videos.
 * Contract: Specs/SPEC-2026-10-01-FREE-VIDEOS.md ("Web — admin"). API: GET /api/admin/v2/free-videos.
 * Mirrors AdminEvents: cover thumb, title, category, status, viewers, Edit.
 * No Clerk provider here: AdminNav owns it; calls go through adminApi().
 */
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Eye, MonitorPlay, Pencil, Plus } from 'lucide-react';
import { captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { EmptyState, ErrorState, Shimmer, youtubeThumb } from '../../components/dash2/shared';
import { errMessage, isAbort } from './adminApi';
import { categoryLabel, freeStatusMeta, listFreeVideos, type FreeVideoRow } from './freeVideosApi';

export default function FreeVideosList() {
  const [items, setItems] = useState<FreeVideoRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await listFreeVideos();
      setItems(r.items);
    } catch (e) {
      if (isAbort(e)) return;
      captureException(e, { where: 'admin2_free_videos_list' });
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (loading && !items) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        {[0, 1, 2].map((i) => <Shimmer key={i} className="h-28 w-full rounded-xl" />)}
      </div>
    );
  }
  if (items && items.length === 0) {
    return (
      <EmptyState icon={<MonitorPlay className="h-6 w-6" />} title="No free videos yet"
        body="Add a YouTube video anyone signed in can watch for free."
        action={<Button asChild><a href="/admin/free-videos/new"><Plus /> New free video</a></Button>} />
    );
  }

  return (
    <ul className={cn('flex flex-col gap-3 transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
      {items?.map((v) => <Row key={v.id} v={v} />)}
    </ul>
  );
}

function Row({ v }: { v: FreeVideoRow }) {
  const st = freeStatusMeta(v.status);
  const img = v.cover_url || youtubeThumb(v.youtube_video_id);
  const edit = `/admin/free-videos/${encodeURIComponent(v.id)}`;
  return (
    <li className="dash-surface overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="flex gap-3 p-3 sm:gap-4 sm:p-4">
        <a href={edit} className="relative block h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-muted sm:h-24 sm:w-32" aria-label={`Edit ${v.title}`}>
          <img src={img} alt="" loading="lazy" className="h-full w-full object-cover" />
        </a>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <a href={edit} className="min-w-0 font-dash text-[16px] font-bold leading-snug text-grand-teal no-underline hover:underline sm:text-[17px]">
            <span className="line-clamp-2">{v.title || 'Untitled video'}</span>
          </a>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={st.variant}>{st.label}</Badge>
            <Badge variant="outline">{categoryLabel(v.category)}</Badge>
            {v.is_live && (
              <span className="inline-flex items-center gap-1 rounded-full bg-destructive px-2 py-0.5 text-[11px] font-bold text-destructive-foreground">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-destructive-foreground" aria-hidden="true" />Live now
              </span>
            )}
            <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-muted-foreground" title="Distinct viewers">
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />{v.viewers ?? 0} viewers
            </span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-border/60 bg-muted/40 px-2 py-1.5 sm:px-3">
        <Button asChild variant="ghost" size="sm"><a href={edit}><Pencil /> Edit</a></Button>
        {v.status === 'published' && (
          <Button asChild variant="ghost" size="sm"><a href={`/watch/${encodeURIComponent(v.id)}`} target="_blank" rel="noopener"><ExternalLink /> View on site</a></Button>
        )}
      </div>
    </li>
  );
}
