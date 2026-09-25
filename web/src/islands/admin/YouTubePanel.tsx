// [DASH2-EVENTS 2026-09-25] "YouTube live link" for the selected listing.
//
// Owner decision VIDEO = YOUTUBE (Specs/SPEC-2026-09-25-DASHBOARD-2.md): the admin
// creates an UNLISTED YouTube live stream and pastes its link here. The same video
// id serves the live event and its replay; the customer dashboard plays it inside
// the guarded player, and the worker only returns the id to people who paid.
//
// GET/PUT /api/admin/listings/:id/youtube {url} -> {ok, youtube_video_id}; url:''
// clears. The worker parses watch?v=, youtu.be/, /live/, /embed/ or a bare id and
// answers 400 invalid_youtube_url otherwise — no client-side parsing here, the
// server is the authority. Styling matches the other admin panels (zine).
import { useEffect, useState } from 'react';
import { ApiError, request } from '../../lib/apiClient';
import { capture } from '../../lib/analytics';

type WithAuth = <T>(run: (token: string) => Promise<T>) => Promise<T>;

function messageFor(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.error === 'invalid_youtube_url') return 'That is not a YouTube link. Paste a watch, youtu.be, /live/ or /embed/ link, or the 11-character video id.';
    const b = e.body as { message?: unknown } | undefined;
    if (b && typeof b.message === 'string' && b.message) return b.message;
    return e.error;
  }
  return 'Could not reach the server.';
}

export default function YouTubePanel({ listingId, withAuth }: { listingId: string; withAuth: WithAuth }) {
  const [videoId, setVideoId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    setLoading(true); setProblem(null); setNote(null); setVideoId(null); setInput('');
    withAuth((t) => request<{ youtube_video_id?: string; url?: string }>(
      `/api/admin/listings/${encodeURIComponent(listingId)}/youtube`, { auth: t },
    )).then((r) => {
      if (dead) return;
      setVideoId(r?.youtube_video_id ?? null);
      setInput(r?.url ?? '');
    }).catch((e) => { if (!dead) setProblem(messageFor(e)); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [listingId, withAuth]);

  async function put(url: string) {
    setSaving(true); setProblem(null); setNote(null);
    try {
      const r = await withAuth((t) => request<{ ok: boolean; youtube_video_id: string | null }>(
        `/api/admin/listings/${encodeURIComponent(listingId)}/youtube`, { method: 'PUT', auth: t, body: { url } },
      ));
      setVideoId(r?.youtube_video_id ?? null);
      if (!url) setInput('');
      setNote(url ? 'Saved. Paid customers will see this video on the event.' : 'Cleared.');
      capture('admin_youtube_link_saved', { listing_id: listingId, cleared: !url, ok: true });
    } catch (e) {
      setProblem(messageFor(e));
      capture('admin_youtube_link_saved', { listing_id: listingId, cleared: !url, ok: false, error: e instanceof ApiError ? e.error : 'network' });
    } finally {
      setSaving(false);
    }
  }

  const btn = 'rounded-full border-zine border-ink px-3 py-1 font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50';
  return (
    <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-[18px] font-semibold text-ink">YouTube live link</h3>
        {videoId && <span className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-inkSoft">id {videoId}</span>}
      </div>
      <p className="mt-2 font-body text-[13px] font-bold text-inkSoft">
        Paste the UNLISTED live stream link. The same video serves the live event and its replay.
      </p>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(e) => { e.preventDefault(); if (input.trim()) void put(input.trim()); }}
      >
        <input
          type="text"
          inputMode="url"
          value={input}
          onChange={(e) => { setInput(e.target.value); setProblem(null); setNote(null); }}
          placeholder={loading ? 'Loading…' : 'https://youtube.com/live/…'}
          disabled={loading || saving}
          aria-invalid={!!problem}
          className="w-full rounded-zineField border-zine border-ink bg-paper px-3 py-2 font-body text-[14px] font-bold text-ink"
        />
        {problem && (
          <p className="rounded-zineField border-zine border-ink bg-paper2 px-3 py-2 font-body text-[13px] font-bold text-coral">{problem}</p>
        )}
        {note && <p className="font-body text-[13px] font-bold text-inkSoft">{note}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={loading || saving || !input.trim()} className={`${btn} bg-paper`}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {videoId && (
            <button type="button" disabled={loading || saving} onClick={() => void put('')} className={`${btn} bg-paper2`}>
              Clear
            </button>
          )}
        </div>
        {videoId && (
          <img
            src={`https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`}
            alt="Video thumbnail"
            className="aspect-video w-full max-w-[320px] rounded-zineField border-zine border-ink object-cover"
          />
        )}
      </form>
    </div>
  );
}
