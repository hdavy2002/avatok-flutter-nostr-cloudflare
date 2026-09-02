/* ListingPublish — the step that did not exist.
 *
 * [LIST-WEB-MEDIA-1] + [LIST-WEB-PUBLISH-1]
 *
 * Before this file, `web/` had NO photo upload (grep for `cover_media` or `api/media`
 * across web/src returned zero hits) and NO publish call — CreatorListings.tsx's only
 * mutation was `status: 'cancelled'`. The create form told people "Next you'll add cover
 * photos and publish" and the page it promised was never built: dashboard/listings/
 * contained index.astro and new.astro, nothing else. So a web draft was permanent.
 *
 * The Flutter app has done this correctly since 2026-06: create_listing_flow.dart posts
 * bytes to /upload/public with an x-content-type header, reads {url}, and requires ≥1
 * photo before publish. This screen copies that flow rather than inventing a second one.
 *
 * The checklist is the point. publishListing refuses for seven distinct reasons and each
 * one used to arrive as a bare code. Here every requirement is visible BEFORE the button
 * is pressed, and each refusal that still gets through is rendered as a sentence.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import { API_BASE, cfImage } from '../../lib/config';
import { listingErrorMessage, isKycGate, isLivenessGate } from '../../lib/listingErrors';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { IslandBoundary } from '../../components/IslandBoundary';
import { capture, withTrace } from '../../lib/analytics';

type Cover = { type: string; url: string };
type Listing = {
  id: string; kind: string; title?: string; category?: string; status?: string;
  price?: number; starts_at?: number | null; duration_min?: number | null;
  capacity?: number | null; cover_media?: unknown;
};

const MAX_COVERS = 5;          // worker: `max 5 photos`
const MAX_BYTES = 8 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 90_000;

// Some Android pickers hand over a File with an empty `type` (notably for HEIC/HEIF).
// Infer the MIME from the extension rather than rejecting the photo outright.
const IMAGE_EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif',
};

function inferImageMime(file: File): string | null {
  if (file.type) return file.type.startsWith('image/') ? file.type : null;
  const m = /\.[^.]+$/.exec(file.name.toLowerCase());
  return m ? IMAGE_EXT_MIME[m[0]] ?? null : null;
}

/** §2.7 `listing_cover_upload` {outcome,status,reason,size,type,ms} — the
 * 2026-09-02 bug. Replaces the old ad-hoc `window.posthog` helper now that
 * `web/src/lib/analytics.ts` is wired everywhere; telemetry must never throw
 * or block the upload flow, hence `capture`'s own internal try/catch. */
function reportUploadOutcome(fields: {
  outcome: 'ok' | 'error'; status: string; reason?: string;
  size?: number; type?: string; ms: number;
}) {
  capture('listing_cover_upload', {
    outcome: fields.outcome,
    status: fields.status,
    reason: fields.reason,
    size: fields.size,
    type: fields.type,
    ms: fields.ms,
  });
}

function parseCovers(raw: unknown): Cover[] {
  const arr = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : raw;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((m) => (m && typeof m === 'object' ? m as Record<string, unknown> : null))
    .filter((m): m is Record<string, unknown> => Boolean(m))
    // The worker stores {type,url}; older rows may carry r2_key. Read both, write {type,url}.
    .map((m) => ({ type: String(m.type ?? 'image'), url: String(m.url ?? m.r2_key ?? '') }))
    .filter((m) => m.url.startsWith('https://'));
}

function Panel({ id }: { id: string }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [covers, setCovers] = useState<Cover[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<'liveness' | 'kyc' | null>(null);
  const [repeatWeeks, setRepeatWeeks] = useState(4);
  const [repeating, setRepeating] = useState(false);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const token = await getActiveToken();
      const r = await request<any>(`/api/listings/${encodeURIComponent(id)}`, { auth: token });
      const data = (r?.listing ?? r ?? {}) as Listing;
      setListing(data);
      setCovers(parseCovers(data.cover_media));
    } catch {
      setError('Could not load this listing.');
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { capture('listing_step_view', { step: 'publish' }); }, []);

  /** Persist the cover list. Kept separate so an upload failure never loses the rest. */
  async function saveCovers(next: Cover[]) {
    const token = await getActiveToken();
    await request(`/api/listings/${encodeURIComponent(id)}`, {
      method: 'PUT', auth: token, body: { cover_media: next },
    });
    setCovers(next);
  }

  async function onFiles(files: FileList | null) {
    if (!files || !files.length || uploading) return;
    setError(null);
    const room = MAX_COVERS - covers.length;
    if (room <= 0) { setError(`You can have up to ${MAX_COVERS} photos.`); return; }
    setUploading(true);
    try {
      // Resolved ONCE, up front — a null token here means an expired/missing session,
      // not a per-file network blip, and every subsequent request would just send
      // `Bearer null` and fail with a confusing 401.
      const token = await getActiveToken();
      if (!token) {
        setError('Please sign in again to upload photos.');
        return;
      }

      const added: Cover[] = [];
      const failures: string[] = [];

      for (const file of Array.from(files).slice(0, room)) {
        const uploadStart = Date.now();
        const mime = inferImageMime(file);
        if (!mime) { failures.push(`${file.name}: photos only, please.`); continue; }
        if (file.size > MAX_BYTES) { failures.push(`${file.name} is too large (max 8 MB).`); continue; }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
        try {
          // Raw bytes with x-content-type — exactly what the app does. This is NOT a
          // multipart form; /upload/public reads req.arrayBuffer() directly.
          const res = await withTrace(() => fetch(`${API_BASE}/upload/public`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'x-content-type': mime,
              'x-file-name': file.name,
              'x-app': 'avatok',
            },
            body: file,
            signal: controller.signal,
          }));
          if (!res.ok) {
            let serverError: string | null = null;
            try {
              const body = await res.json() as { error?: string };
              serverError = typeof body?.error === 'string' ? body.error : null;
            } catch { /* non-JSON error body */ }
            failures.push(serverError
              ? `Upload rejected (${res.status}): ${serverError}`
              : `Couldn't upload ${file.name} (${res.status}).`);
            reportUploadOutcome({
              outcome: 'error', status: String(res.status), reason: serverError ?? undefined,
              size: file.size, type: mime, ms: Date.now() - uploadStart,
            });
            continue;
          }
          const body = await res.json() as { url?: string };
          if (body.url) {
            added.push({ type: 'image', url: body.url });
            reportUploadOutcome({
              outcome: 'ok', status: '200', size: file.size, type: mime, ms: Date.now() - uploadStart,
            });
          }
        } catch (e) {
          const aborted = e instanceof DOMException && e.name === 'AbortError';
          const reason = aborted
            ? 'timed out'
            : e instanceof TypeError
              ? 'network/connection error'
              : e instanceof Error ? e.message : 'unknown error';
          failures.push(`Couldn't upload ${file.name}: ${reason}`);
          reportUploadOutcome({
            outcome: 'error', status: aborted ? 'timeout' : (e instanceof Error ? e.name : 'unknown'),
            reason, size: file.size, type: mime, ms: Date.now() - uploadStart,
          });
        } finally {
          clearTimeout(timer);
        }
      }

      if (added.length) {
        const saveStart = Date.now();
        try {
          await saveCovers([...covers, ...added]);
        } catch (e) {
          const reason = e instanceof ApiError
            ? `Upload rejected (${e.status}): ${e.error}`
            : e instanceof TypeError ? 'network/connection error' : 'Try again.';
          failures.push(`Photos uploaded but could not be saved: ${reason}`);
          reportUploadOutcome({
            outcome: 'error',
            status: e instanceof ApiError ? String(e.status) : (e instanceof Error ? e.name : 'unknown'),
            reason, ms: Date.now() - saveStart,
          });
        }
      }

      if (failures.length) setError(failures.join(' '));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function removeCover(url: string) {
    if (busy || uploading) return;
    try { await saveCovers(covers.filter((c) => c.url !== url)); }
    catch { setError('Could not remove that photo.'); }
  }

  async function repeat() {
    if (repeating || busy) return;
    setRepeating(true); setError(null);
    try {
      const token = await getActiveToken();
      const r = await withTrace(() => request<{ listing_ids?: string[] }>(
        `/api/listings/${encodeURIComponent(id)}/repeat`,
        { method: 'POST', auth: token, body: { weeks: repeatWeeks } },
      ));
      const n = r.listing_ids?.length ?? 0;
      capture('listing_repeat', { weeks: repeatWeeks, outcome: 'ok' });
      // Straight to the list: the copies are drafts and each needs its own publish, so
      // the useful next screen is the one that shows all of them.
      window.location.href = `/dashboard/listings?repeated=${n}`;
    } catch (e) {
      setError(e instanceof ApiError
        ? listingErrorMessage(e.error, (e.body as { detail?: unknown } | null)?.detail)
        : 'Could not make the copies. Try again.');
      capture('listing_repeat', { weeks: repeatWeeks, outcome: 'error' });
    } finally { setRepeating(false); }
  }

  async function publish() {
    if (busy || !listing) return;
    setBusy(true); setError(null); setGate(null);
    try {
      const token = await getActiveToken();
      await withTrace(() => request(`/api/listings/${encodeURIComponent(id)}/publish`, { method: 'POST', auth: token }));
      capture('listing_publish', {
        outcome: 'ok', status: 200, kind: listing.kind, price: listing.price ?? 0,
        free_entry: !listing.price,
      });
      window.location.href = `/dashboard/listings?published=${encodeURIComponent(id)}`;
    } catch (e) {
      if (e instanceof ApiError) {
        if (isLivenessGate(e.error)) setGate('liveness');
        if (isKycGate(e.error)) setGate('kyc');
        setError(listingErrorMessage(e.error, (e.body as { detail?: unknown } | null)?.detail));
      } else {
        setError('Could not publish. Try again.');
      }
      capture('listing_publish', {
        outcome: 'error',
        status: e instanceof ApiError ? e.status : 0,
        reason: e instanceof ApiError ? e.error : (e instanceof Error ? e.message : 'unknown'),
        kind: listing.kind, price: listing.price ?? 0, free_entry: !listing.price,
      });
    } finally { setBusy(false); }
  }

  if (loading) return <div className="font-body font-bold text-inkSoft">Loading…</div>;
  if (!listing) return <p className="font-body font-bold text-coral">⚠ {error ?? 'Listing not found.'}</p>;

  const isLive = listing.kind === 'live_event' || listing.kind === 'live';
  const published = listing.status && listing.status !== 'draft';

  // Mirrors publishListing's creator-services branch, in the same order it checks.
  const checks: { ok: boolean; label: string; fix?: { href: string; label: string } }[] = [
    { ok: Boolean(listing.title), label: 'Has a title', fix: { href: `/dashboard/listings/new?id=${id}`, label: 'Edit' } },
    { ok: Boolean(listing.category), label: 'Has a category', fix: { href: `/dashboard/listings/new?id=${id}`, label: 'Edit' } },
    { ok: covers.length >= 1, label: `Has at least one photo (${covers.length}/${MAX_COVERS})` },
    ...(isLive
      ? [
        { ok: Boolean(listing.starts_at) && Number(listing.starts_at) > Date.now(), label: 'Starts in the future', fix: { href: `/dashboard/listings/new?id=${id}`, label: 'Edit' } },
        { ok: Number(listing.duration_min) >= 5 && Number(listing.duration_min) <= 480, label: 'Length is set', fix: { href: `/dashboard/listings/new?id=${id}`, label: 'Edit' } },
      ]
      : [
        { ok: [1, 10, 20].includes(Number(listing.capacity)), label: 'Booking capacity is set', fix: { href: `/dashboard/listings/new?id=${id}`, label: 'Edit' } },
        // Availability lives in AvaCalendar and cannot be read from here, so it is shown
        // as a reminder rather than a tick. The worker refuses with `no_availability`
        // and listingErrors turns that into the same sentence.
        { ok: true, label: 'Availability set in AvaCalendar', fix: { href: '/dashboard/calendar', label: 'Open' } },
      ]),
  ];
  const ready = checks.every((c) => c.ok);

  return (
    <div className="flex max-w-lg flex-col gap-5">
      <Card fillClassName="bg-paper2">
        <p className="font-display font-semibold text-[18px] text-ink">{listing.title || 'Untitled listing'}</p>
        <p className="mt-1 font-body font-bold text-[13px] text-inkSoft">
          {isLive ? 'Live event' : '1:1 consult'} · {listing.price ? `₹${listing.price}` : 'Free'}
        </p>
      </Card>

      <div>
        <span className="mb-2 block font-mono font-bold uppercase text-[13px] tracking-[0.08em] text-inkSoft">
          Photos
        </span>
        <div className="grid grid-cols-3 gap-3">
          {covers.map((c) => (
            <div key={c.url} className="relative overflow-hidden rounded-zine border-zine border-ink shadow-zine-xs">
              {/* cfImage, not a hand-built path: it splices the transform segment after
                  the ORIGIN of an absolute URL. Prefixing the whole https:// URL with
                  /cdn-cgi/image/ (the obvious-looking version) produces a broken path. */}
              <img src={cfImage(c.url, { width: 300, fit: 'cover' })}
                onError={(e) => { (e.currentTarget as HTMLImageElement).src = c.url; }}
                alt="" className="aspect-square w-full object-cover" />
              <button type="button" onClick={() => void removeCover(c.url)}
                className="absolute right-1 top-1 rounded-full border-zine border-ink bg-card px-2 py-0.5 font-body font-bold text-[12px] text-ink">
                ✕
              </button>
            </div>
          ))}
          {covers.length < MAX_COVERS && (
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
              className="flex aspect-square items-center justify-center rounded-zine border-zine border-dashed border-ink bg-card font-body font-bold text-[13px] text-inkSoft">
              {uploading ? 'Uploading…' : '+ Add'}
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden
          onChange={(e) => void onFiles(e.target.files)} />
      </div>

      <div className="flex flex-col gap-2">
        {checks.map((c) => (
          <div key={c.label} className="flex items-center gap-2">
            <span className={c.ok ? 'text-lime' : 'text-coral'}>{c.ok ? '✓' : '○'}</span>
            <span className="flex-1 font-body font-bold text-[14px] text-ink">{c.label}</span>
            {!c.ok && c.fix && (
              <a href={c.fix.href} className="font-body font-bold text-[13px] text-blueInk underline">{c.fix.label}</a>
            )}
          </div>
        ))}
      </div>

      {isLive && (
        <Card fillClassName="bg-paper2">
          <p className="font-body font-bold text-[13px] text-inkSoft">
            Once published, an event&rsquo;s date can&rsquo;t be changed — you&rsquo;d have to cancel and create a new one.
            Publishing also holds that time in your calendar.
          </p>
        </Card>
      )}

      {error && <p className="font-body font-bold text-[14px] text-coral">⚠ {error}</p>}

      {gate && (
        <Card fillClassName="bg-paper2">
          <p className="font-body font-bold text-[13px] text-inkSoft">
            {gate === 'liveness'
              ? 'This takes about a minute with your camera.'
              : 'This is a one-time identity check before you can sell sessions.'}
          </p>
          <a href="/dashboard/identity" className="mt-2 inline-block font-body font-bold text-[14px] text-blueInk underline">
            Verify now
          </a>
        </Card>
      )}

      {published
        ? <p className="font-body font-bold text-[14px] text-ink">This listing is already published.</p>
        : <Button variant="lime" label="Publish" loading={busy} disabled={!ready} onClick={publish} fullWidth />}

      {/* [CARD-SLOTS-1] One listing is one event (owner decision 2026-08-29), so a weekly
          show is N listings sharing a series_id — not one listing with N sessions. Each
          copy is a DRAFT: publishing claims a calendar block and can clash, and doing N
          claims at once would fail halfway with no obvious repair.
          Collapsed behind a secondary link and closed by default (owner request) — this
          is a once-in-a-while convenience, not a step in the main publish path, and it
          used to visually compete with the Publish button below it. */}
      {isLive && !published && (
        <div>
          <button type="button" onClick={() => setRepeatOpen((v) => !v)}
            className="font-body font-bold text-[13px] text-blueInk underline">
            Runs every week? Make copies (optional)
          </button>
          {repeatOpen && (
            <Card fillClassName="bg-paper2" className="mt-2">
              <span className="mb-1 block font-mono font-bold uppercase text-[11px] tracking-[0.1em] text-inkSoft">
                Optional
              </span>
              <p className="font-body font-bold text-[13px] text-inkSoft">
                Make copies now — each one gets its own date and its own seats, and you
                publish them one at a time.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <select value={repeatWeeks} onChange={(e) => setRepeatWeeks(Number(e.target.value))}
                  className="rounded-zineField border-zine border-ink bg-card px-3 py-2 font-body font-bold text-[14px] text-ink">
                  {[1, 2, 3, 4, 6, 8, 12].map((w) => <option key={w} value={w}>{w} more week{w === 1 ? '' : 's'}</option>)}
                </select>
                <Button variant="blue" label="Make copies" loading={repeating} onClick={repeat} />
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

/*
 * [LIST-WEB-GATE-1 2026-08-30] NO CLIENT-SIDE ACCOUNT GATE HERE, DELIBERATELY.
 *
 * An earlier pass wrapped this island in <RequireAccount> because the file header had
 * always CLAIMED it was gated and it was not. That broke the page in two different ways,
 * neither visible to the typechecker or the build — only in a browser, on the live site:
 *
 *   1. <RequireAccount> mounts <ClerkIsland> -> <ClerkProvider>. SidebarUser already
 *      mounts one on every dashboard page (see islands/shell/SidebarUser.tsx:15, which
 *      says so in as many words). Clerk's provider check is global, not per React root,
 *      so the second one threw "You've added multiple <ClerkProvider> components" and the
 *      WHOLE island failed to render: the New Listing page showed a heading and no form.
 *
 *   2. Dropping the provider (RequireAccountInline) moved the failure rather than fixing
 *      it. Astro islands are SEPARATE React roots, so this island is not inside
 *      SidebarUser's provider — and the gate's own <SignInButton> then threw
 *      "SignInButton can only be used within <ClerkProvider>".
 *
 * The gate was also solving nothing. /dashboard/* is reached only when signed in, every
 * call this island makes carries a bearer token, and the WORKER rejects an unauthenticated
 * create outright. The server is the authority; a client gate here was decoration that
 * cost the page its form.
 *
 * If a gate is ever genuinely wanted on a dashboard island, it must reuse SidebarUser's
 * provider rather than mount a second one — which means solving the cross-island problem
 * first, not wrapping the component.
 */
export function ListingPublish() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    try { setId(new URLSearchParams(window.location.search).get('id')); } catch { /* */ }
  }, []);
  return (
    <IslandBoundary island="dashboard-listing-publish">
      {!id ? <p className="font-body font-bold text-inkSoft">No listing selected.</p> : <Panel id={id} />}
    </IslandBoundary>
  );
}

export default ListingPublish;
