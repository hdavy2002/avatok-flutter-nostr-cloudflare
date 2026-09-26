// Past events — [DASH2-EVENTS 2026-09-25]. /dashboard/past.
// Contract: Specs/SPEC-2026-09-25-DASHBOARD-2.md, GET /api/me/events?scope=past.
//
// A grid of video cards. The event's unlisted YouTube video (returned only to
// people who paid) plays in the guarded player — a Dialog on tablet/desktop, a
// vaul Drawer on phones. No video yet → "Recording coming soon".
// dash2_replay_play / dash2_replay_error.
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, CalendarDays, Clock, Download, Film, History, Play } from 'lucide-react';
import { capture } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '../../components/ui/drawer';
import {
  authedRequest, EmptyState, ErrorState, errorMessage, fetchMyCheckoutsSafe, fmtDuration, fmtIstDate, fmtIstDateTime,
  listingImage, Shimmer, useIsPhone, youtubeThumb, type EventItem, type EventsResponse, type SaathumCheckoutSummary,
} from '../../components/dash2/shared';
import { YouTubeGuardedPlayer } from '../../components/dash2/YouTubeGuardedPlayer';

/** The newest CONFIRMED Saa Thum checkout for this listing, if any — used only to
 * decide whether "Download video" / "Video coming soon" shows on a past-event card.
 * A listing with no matching checkout keeps today's behaviour exactly (no row added). */
function findCheckout(checkouts: SaathumCheckoutSummary[], listingId: string): SaathumCheckoutSummary | null {
  const matches = checkouts.filter((c) => c.listing.id === listingId && c.status === 'confirmed');
  if (!matches.length) return null;
  return matches.reduce((best, c) => (c.created_at > best.created_at ? c : best));
}

function VideoCard({
  item, index, onOpen, checkout,
}: { item: EventItem; index: number; onOpen: (i: EventItem) => void; checkout: SaathumCheckoutSummary | null }) {
  const reduce = useReducedMotion();
  const vid = item.youtube_video_id;
  const downloadUrl = checkout?.video_download_url ?? null;
  const thumb = vid ? youtubeThumb(vid) : listingImage(item.listing.image_url, 640);
  const duration = fmtDuration(item.listing.duration_min);
  const body = (
    <>
      <div className="relative aspect-video overflow-hidden bg-muted">
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" decoding="async" className={cn('h-full w-full object-cover transition-transform duration-500 motion-reduce:transition-none', vid ? 'group-hover:scale-[1.04] motion-reduce:group-hover:scale-100' : 'opacity-70 saturate-50')} />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-secondary to-muted text-grand-teal"><Film className="h-10 w-10 opacity-50" /></div>
        )}
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-scrim/80 via-scrim/15 to-transparent" />
        {vid ? (
          <span aria-hidden="true" className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[var(--dash-shadow-lg,none)] ring-4 ring-primary/20 transition-transform duration-300 group-hover:scale-110 motion-reduce:transition-none motion-reduce:group-hover:scale-100">
            <Play className="ml-0.5 h-6 w-6 fill-current" />
          </span>
        ) : (
          <span className="absolute inset-x-3 bottom-3 inline-flex w-fit items-center gap-1.5 rounded-full bg-card px-3 py-1 text-[12px] font-extrabold text-muted-foreground shadow-sm">
            <Film className="h-3.5 w-3.5" /> Recording coming soon
          </span>
        )}
        {vid && duration && (
          <span className="absolute bottom-3 right-3 rounded-md bg-scrim/80 px-2 py-0.5 text-[12px] font-extrabold tabular-nums text-grand-cream">{duration}</span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-4 text-left">
        <Badge variant="secondary" className="w-fit">{item.listing.category_label || item.listing.category}</Badge>
        <h3 className="line-clamp-2 font-dash text-[16px] font-bold leading-[1.25] text-foreground">{item.listing.title}</h3>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-semibold text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" /> {fmtIstDate(item.starts_at)}</span>
          {duration && <span className="inline-flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" /> {duration}</span>}
        </p>
      </div>
    </>
  );
  const cls = 'group flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border/50 bg-card shadow-[var(--dash-shadow,none)] transition-all duration-300 motion-reduce:transition-none';
  const clickableCls = 'flex w-full flex-col text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index, 8) * 0.04 }}
    >
      <div className={cn(cls, vid && 'hover:-translate-y-1 hover:border-border hover:shadow-[var(--dash-shadow-lg,none)] motion-reduce:hover:translate-y-0')}>
        {vid ? (
          <button type="button" onClick={() => onOpen(item)} aria-label={`Watch ${item.listing.title}`} className={clickableCls}>
            {body}
          </button>
        ) : (
          <div className={clickableCls}>{body}</div>
        )}
        {checkout && (
          <div className="flex items-center gap-2 border-t border-border/40 px-4 py-3">
            {downloadUrl ? (
              <a
                href={downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="You can download your video anytime."
                onClick={() => capture('dash2_video_download', { listing_id: item.listing.id })}
                className="inline-flex items-center gap-1.5 text-[13px] font-extrabold text-primary hover:underline"
              >
                <Download className="h-3.5 w-3.5" /> Download video
              </a>
            ) : (
              <span
                title="You can download your video anytime."
                className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground"
              >
                <Clock className="h-3.5 w-3.5" /> Video coming soon
              </span>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function PlayerBody({ item, onError }: { item: EventItem; onError: (code: number) => void }) {
  return (
    <div className="space-y-3">
      <YouTubeGuardedPlayer
        videoId={item.youtube_video_id!}
        title={item.listing.title}
        poster={item.listing.image_url ? listingImage(item.listing.image_url, 1280) : null}
        autoPlay
        onError={onError}
      />
      <p className="text-[13px] font-semibold text-muted-foreground">
        {fmtIstDateTime(item.starts_at)}{item.listing.duration_min ? ` · ${fmtDuration(item.listing.duration_min)}` : ''}
      </p>
    </div>
  );
}

export default function PastEvents() {
  const phone = useIsPhone();
  const [data, setData] = useState<EventsResponse | null>(null);
  const [checkouts, setCheckouts] = useState<SaathumCheckoutSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<EventItem | null>(null);
  const openedAt = useRef(0);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await authedRequest<EventsResponse>('/api/me/events', { query: { scope: 'past' }, timeoutMs: 20000 });
      setData({ now: r?.now ?? Date.now(), items: r?.items ?? [] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
    // Independent of the dashboard's own events call: my-checkouts may 404/fail until
    // A1 deploys, and fetchMyCheckoutsSafe() already swallows that to [] — the page
    // above must render exactly as it does today either way.
    setCheckouts(await fetchMyCheckoutsSafe());
  }, []);
  useEffect(() => { void load(); }, [load]);

  const openItem = (i: EventItem) => {
    openedAt.current = Date.now();
    setOpen(i);
    capture('dash2_replay_play', { event_id: i.listing.id, order_id: i.order_id, surface: phone ? 'drawer' : 'dialog' });
  };
  const onError = (code: number) => {
    if (!open) return;
    capture('dash2_replay_error', { event_id: open.listing.id, code, ms_after_open: Date.now() - openedAt.current });
  };

  if (loading && !data) {
    return (
      <div className="grid gap-5 min-[480px]:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="overflow-hidden rounded-2xl border border-border/40 bg-card">
            <Shimmer className="aspect-video rounded-none" />
            <div className="space-y-2.5 p-4"><Shimmer className="h-3 w-20" /><Shimmer className="h-4 w-4/5" /><Shimmer className="h-3 w-1/2" /></div>
          </div>
        ))}
      </div>
    );
  }
  if (error && !data) return <ErrorState message={error} onRetry={() => void load()} />;
  const items = data?.items ?? [];
  if (!items.length) {
    return (
      <EmptyState
        icon={<History className="h-6 w-6" />}
        title="No past pujas yet"
        body="Once a puja you booked has taken place, its recording appears here so you can watch it again."
        action={<Button asChild variant="accent"><a href="/dashboard">Book a puja <ArrowRight /></a></Button>}
      />
    );
  }

  const title = open?.listing.title ?? '';
  return (
    <div className="font-dashbody">
      <div className="grid gap-5 min-[480px]:grid-cols-2 lg:grid-cols-3">
        {items.map((i, idx) => (
          <VideoCard
            key={i.order_id ?? `${i.listing.id}-${idx}`}
            item={i}
            index={idx}
            onOpen={openItem}
            checkout={findCheckout(checkouts, i.listing.id)}
          />
        ))}
      </div>

      {phone ? (
        <Drawer open={!!open} onOpenChange={(v) => { if (!v) setOpen(null); }} shouldScaleBackground={false}>
          <DrawerContent>
            <DrawerHeader className="text-left">
              <DrawerTitle className="text-grand-teal">{title}</DrawerTitle>
              <DrawerDescription>Recording of your puja</DrawerDescription>
            </DrawerHeader>
            <div className="px-4 pb-6">{open?.youtube_video_id && <PlayerBody item={open} onError={onError} />}</div>
          </DrawerContent>
        </Drawer>
      ) : (
        <Dialog open={!!open} onOpenChange={(v) => { if (!v) setOpen(null); }}>
          <DialogContent className="max-w-4xl p-4 sm:p-6">
            <DialogHeader className="pr-10">
              <DialogTitle className="text-grand-teal">{title}</DialogTitle>
              <DialogDescription>Recording of your puja</DialogDescription>
            </DialogHeader>
            {open?.youtube_video_id && <PlayerBody item={open} onError={onError} />}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
