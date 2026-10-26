/* [HF-EXPLORE-PUBLIC-1] Public reels page (/explore and /r/<id>): ONE official embed per screen, wheel / swipe / buttons / arrow keys move between reels.
 * [HF-REEL-OVERLAY-WEB-1] Everything sits INSIDE the 9:16 video frame: Call now / Invite bottom-right, the Comments / Save / Like / Share rail above it.
 * YouTube: the player is shown as it is (its own title, sound icon, menu); our see-through tap layer (tap = play / pause) covers all of it except YouTube's
 * sound icon, and a frosted patch hides YouTube's own like / share behind our rail. Instagram: the white card is cropped away (the reel fills the frame), the
 * middle of the video belongs to Instagram's own play / pause, two transparent strips (top / bottom) only carry swipes, and we draw the creator + caption.
 * Watching and scrolling are free; Like / Comment / Save open the sign-in card when logged out.
 * Telemetry: explore_reel_view, explore_reel_swipe, explore_signin_prompt {action}, explore_call_tap, explore_share. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClerkIsland, getActiveToken, getActiveTokenWaited, activeSessionSignedOut, ACTIVE_SESSION_CHANGED } from '../../lib/clerk';
import { hfCall } from '../../lib/hfCallsApi';
import { capture } from '../../lib/analytics';
import { brandUrl } from '../../lib/brand';
import { GATE_COPY, compactCount, playable, playerFor, signInHref, sizeFor, tapClipPath, whatsappGateHref, whoOf, ytCmd, type GateAction, type ReelItem } from '../../lib/hfExplore';

const YT_ORIGIN = 'https://www.youtube-nocookie.com';
/** [HF-EXPLORE-SMOOTH-1] What one YouTube player last told us (it only talks after the "listening" handshake). */
interface YtState { ready: boolean; state: number; time: number; warm: boolean; seen: boolean; hello: number; tries: number }

interface Comment { id: string; author: { name: string; avatar?: string | null }; body: string; createdAt: number | string; mine?: boolean }
interface Props { initial: ReelItem[]; nextCursor: string | null }

const ago = (t: number | string): string => {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const Icon = {
  heart: (on: boolean) => <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20.5s-7.5-4.6-9.2-9.3C1.6 7.9 3.6 4.5 7 4.5c2 0 3.9 1.1 5 2.9 1.1-1.8 3-2.9 5-2.9 3.4 0 5.4 3.4 4.2 6.7-1.7 4.7-9.2 9.3-9.2 9.3z" /></svg>,
  comment: <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a8.5 8.5 0 0 1-12.4 7.5L3 21l1.6-5.2A8.5 8.5 0 1 1 21 12z" /></svg>,
  save: (on: boolean) => <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3.5h12v17l-6-4.2-6 4.2z" /></svg>,
  plane: <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z" /></svg>,
  thumb: (on: boolean) => <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 10.5V21H3.5V10.5zM7 10.5l4-7.2a2 2 0 0 1 2.2 1.9v4.3h5.6a2 2 0 0 1 2 2.4l-1.3 6.8a2 2 0 0 1-2 1.6H7" /></svg>,
  ytShare: <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4.5 21.5 11 14 17.5v-3.7c-5.2 0-8.4 1.6-10.5 5.2.6-5.8 4-9.7 10.5-10.4z" /></svg>,
  plus: <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>,
  igMark: <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="6" /><path d="M10 8.5v7l5.5-3.5z" fill="currentColor" /></svg>,
  phone: <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.6 21 3 13.4 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.3.2 2.5.57 3.6a1 1 0 0 1-.25 1z" /></svg>,
  up: <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="m6 15 6-6 6 6" /></svg>,
  down: <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>,
  close: <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>,
};

export default function ExploreReels(props: Props) {
  return <ClerkIsland><Reels {...props} /></ClerkIsland>;
}

function Reels({ initial, nextCursor }: Props) {
  const [items, setItems] = useState<ReelItem[]>(() => playable(initial));
  const [cursor, setCursor] = useState<string | null>(nextCursor);
  const [idx, setIdx] = useState(0);
  const [muted, setMuted] = useState(true);
  const [paused, setPaused] = useState(false);
  const [size, setSize] = useState({ w: 360, h: 640 });
  const [signedIn, setSignedIn] = useState(false);
  const [gate, setGate] = useState<GateAction | null>(null);
  const [liked, setLiked] = useState<Record<string, boolean>>({});
  const [likeN, setLikeN] = useState<Record<string, number>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState('');
  const [panel, setPanel] = useState(false);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [commentN, setCommentN] = useState<Record<string, number>>({});
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [cErr, setCErr] = useState('');
  const frameRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const frames = useRef<Record<string, HTMLIFrameElement | null>>({});
  const lastNav = useRef(0);
  const touchY = useRef<number | null>(null);
  const known = useRef(new Set<string>());
  const fetching = useRef(false);
  const origin = typeof location !== 'undefined' ? location.origin : '';
  // [HF-EXPLORE-SMOOTH-1] player states, the poster switch, and when the current reel came on screen
  const yt = useRef<Record<string, YtState>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const curSince = useRef(Date.now());
  const soundOff = useRef(new Set<string>());
  const started = useRef(new Set<string>());
  const wheelAcc = useRef(0);
  const wheelLast = useRef(0);
  const wheelLock = useRef(false);

  const cur = items[idx];
  const live = useRef({ idx, items, muted, paused, cursor, panel });
  live.current = { idx, items, muted, paused, cursor, panel };
  useEffect(() => { for (const i of items) known.current.add(i.id); }, [items]);

  const say = useCallback((m: string) => { setToast(m); window.setTimeout(() => setToast(t => (t === m ? '' : t)), 2400); }, []);

  // ---- session ----
  useEffect(() => {
    let alive = true;
    const check = async () => { const t = await getActiveToken().catch(() => null); if (alive) setSignedIn(!!t); };
    void check();
    window.addEventListener(ACTIVE_SESSION_CHANGED, check);
    return () => { alive = false; window.removeEventListener(ACTIVE_SESSION_CHANGED, check); };
  }, []);

  // ---- frame size (the iframe is fitted inside it) ----
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth || 360, h: el.clientHeight || 640 });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- more pages ----
  const more = useCallback(async () => {
    const c = live.current.cursor;
    if (!c || fetching.current) return;
    fetching.current = true;
    const r = await hfCall<{ ok: true; items: ReelItem[]; nextCursor: string | null }>('GET', `/api/hf/reels?limit=10&cursor=${encodeURIComponent(c)}`, undefined, { auth: false });
    fetching.current = false;
    if (!r.ok) return;
    const fresh = playable(r.data.items ?? []).filter(i => !known.current.has(i.id));
    setItems(prev => [...prev, ...fresh]);
    setCursor(r.data.nextCursor ?? null);
    if (!fresh.length && r.data.nextCursor) { live.current.cursor = r.data.nextCursor; void more(); }
  }, []);
  useEffect(() => { if (cursor && idx >= items.length - 3) void more(); }, [idx, items.length, cursor, more]);

  // ---- per-user state (liked / saved) once signed in ----
  useEffect(() => {
    if (!signedIn) return;
    void hfCall<{ ok: true; items: { id: string }[] }>('GET', '/api/hf/reel-bookmarks').then(r => {
      if (r.ok) setSaved(Object.fromEntries((r.data.items ?? []).map(i => [i.id, true])));
    });
  }, [signedIn]);
  const likedChecked = useRef(new Set<string>());
  useEffect(() => {
    if (!signedIn || !cur || likedChecked.current.has(cur.id)) return;
    likedChecked.current.add(cur.id);
    void hfCall<{ ok: true; item: ReelItem }>('GET', `/api/hf/reels/${cur.id}`).then(r => {
      if (!r.ok) return;
      setLiked(l => ({ ...l, [cur.id]: r.data.item.likedByMe === true }));
      setLikeN(n => ({ ...n, [cur.id]: r.data.item.likes }));
    });
  }, [signedIn, cur]);

  // ---- [HF-EXPLORE-SMOOTH-1] play the current reel, warm the next one, pause the rest ----
  // The old code fired play commands blind at 0 / 0.6 / 1.6 s. A player that was not ready by then never got one (photo, no
  // video), and a scroll-wheel is not a "user gesture", so an unmuted play was refused by the browser (paused, or sound off).
  // Now every player reports its state to us and a 300 ms loop keeps the current one playing.
  const ys = (id: string): YtState => (yt.current[id] ??= { ready: false, state: -1, time: 0, warm: false, seen: false, hello: 0, tries: 0 });
  const hello = (id: string) => {
    try { frames.current[id]?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id, channel: 'widget' }), YT_ORIGIN); } catch { /* not loaded yet */ }
  };
  const reveal = (id: string) => setShown(m => (m[id] ? m : { ...m, [id]: true }));
  const drive = useCallback(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    const { items: its, idx: i, paused: pz } = live.current;
    const curId = its[i]?.id;
    const now = Date.now();
    const curIt = its[i];
    const curBusy = !!curId && !!curIt && playerFor(curIt)?.platform === 'youtube' && yt.current[curId]?.state !== 1;
    for (const [id, el] of Object.entries(frames.current)) {
      if (!el) continue;
      const it = its.find(x => x.id === id);
      if (!it || playerFor(it)?.platform !== 'youtube') continue;
      const s = ys(id);
      const isCur = id === curId;
      if (!s.ready) {
        if (s.hello < 80) { s.hello++; hello(id); }
        if (isCur) {
          ytCmd(el, live.current.muted ? 'mute' : 'unMute'); ytCmd(el, 'playVideo'); // blind, as before, in case the player never answers
          if (now - curSince.current > 4000) reveal(id); // never hide a video behind its poster for good
        }
        continue;
      }
      if (isCur) {
        if (pz) { if (s.state === 1) ytCmd(el, 'pauseVideo'); continue; }
        if (s.state === 1 || s.state === 3) continue; // playing, or buffering on its way
        if (!live.current.muted && !soundOff.current.has(id) && now - curSince.current > 2500) {
          // the browser refused to start it with sound: play it muted rather than show a still photo
          soundOff.current.add(id);
          live.current.muted = true;
          setMuted(true);
          say('Sound is off. Tap the speaker on the video to turn it on.');
          capture('explore_reel_sound_blocked', { reel_id: id });
        }
        ytCmd(el, live.current.muted ? 'mute' : 'unMute');
        ytCmd(el, 'playVideo');
      } else if (s.state === 1) {
        ytCmd(el, 'pauseVideo');
        s.warm = true;
      } else if (!s.warm && s.state !== 3 && !curBusy && s.tries < 30) {
        s.tries++;
        ytCmd(el, 'mute'); ytCmd(el, 'playVideo'); // warm up: play muted to the first frame, then stop (below)
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onState = (id: string) => {
    const s = ys(id);
    const { items: its, idx: i } = live.current;
    const isCur = its[i]?.id === id;
    if (s.state !== 1) return;
    if (!isCur) { ytCmd(frames.current[id], 'pauseVideo'); s.warm = true; return; }
    s.warm = true; s.seen = true;
    reveal(id);
    if (!started.current.has(id)) {
      started.current.add(id);
      capture('explore_reel_start', { reel_id: id, ms: Date.now() - curSince.current, index: i });
    }
  };
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== YT_ORIGIN && e.origin !== 'https://www.youtube.com') return;
      let d: any; // eslint-disable-line @typescript-eslint/no-explicit-any
      try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
      if (!d || typeof d !== 'object') return;
      const id = Object.keys(frames.current).find(k => frames.current[k]?.contentWindow === e.source);
      if (!id) return;
      const s = ys(id);
      let st: number | null = null;
      if (d.event === 'onReady') s.ready = true;
      if (d.event === 'onStateChange' && typeof d.info === 'number') st = d.info;
      if (d.event === 'infoDelivery' && d.info && typeof d.info === 'object') {
        s.ready = true;
        if (typeof d.info.playerState === 'number') st = d.info.playerState;
        if (typeof d.info.currentTime === 'number') s.time = d.info.currentTime;
        // [HF-REEL-OVERLAY-WEB-1] YouTube's own sound icon is the control now: follow it, so the choice carries to the next reels.
        // Ignore the first moments of a reel (a warmed player still reports the muted state of its warm-up) and anything but live playback.
        if (typeof d.info.muted === 'boolean' && live.current.items[live.current.idx]?.id === id && s.state === 1
          && Date.now() - curSince.current > 1200 && d.info.muted !== live.current.muted) {
          live.current.muted = d.info.muted;
          setMuted(d.info.muted);
        }
      }
      if (st != null && st !== s.state) { s.state = st; onState(id); }
      if (d.event === 'onReady') drive();
    };
    window.addEventListener('message', on);
    const tick = window.setInterval(drive, 300);
    return () => { window.removeEventListener('message', on); window.clearInterval(tick); };
  }, [drive]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setPaused(false);
    live.current.paused = false;
    curSince.current = Date.now();
    const id = items[idx]?.id;
    const s = id ? yt.current[id] : undefined;
    // a warmed reel is a frame or two in: start it from the top only if it really moved on
    if (id && s?.ready && s.warm && !s.seen && s.time > 1) ytCmd(frames.current[id], 'seekTo', [0, true]);
    drive();
  }, [idx, drive]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const el = cur && frames.current[cur.id]; if (el) ytCmd(el, muted ? 'mute' : 'unMute'); }, [muted, cur]);
  useEffect(() => {
    if (!cur) return;
    capture('explore_reel_view', { reel_id: cur.id, kind: cur.kind === 'invite' ? 'invite' : 'network', index: idx, platform: cur.platform });
    if (cur.id.startsWith('hfrl_')) void hfCall('POST', `/api/hf/reels/${cur.id}/view`, undefined, { auth: false });
  }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- moving between reels ----
  const go = useCallback((d: 1 | -1, method: 'wheel' | 'touch' | 'button' | 'key') => {
    const now = Date.now();
    if (now - lastNav.current < (method === 'wheel' ? 280 : 550)) return; // [HF-EXPLORE-SMOOTH-1] a mouse notch every ~0.3 s is honoured
    const n = live.current.idx + d;
    if (n < 0 || n >= live.current.items.length) return;
    lastNav.current = now;
    setIdx(n);
    setPanel(false);
    setComments(null);
    capture('explore_reel_swipe', { direction: d > 0 ? 'next' : 'prev', method });
  }, []);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('.ex-panel, .ex-gate')) return;
      e.preventDefault();
      // [HF-EXPLORE-SMOOTH-1] add up small wheel steps (Firefox sends lines, smooth mice send many tiny steps — each was
      // under the old 18 px bar, so it took several scrolls), then one move per gesture so trackpad momentum skips nothing.
      const now = Date.now();
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * (root.clientHeight || 800) : e.deltaY;
      const gap = now - wheelLast.current;
      wheelLast.current = now;
      if (wheelLock.current) {
        if (gap < 160 && now - lastNav.current < 1000) return; // the same flick still coasting
        wheelLock.current = false;
        wheelAcc.current = 0;
      }
      if (gap > 160) wheelAcc.current = 0;
      wheelAcc.current += px;
      if (Math.abs(wheelAcc.current) >= 40) {
        const d = wheelAcc.current > 0 ? 1 : -1;
        wheelAcc.current = 0;
        wheelLock.current = true;
        go(d, 'wheel');
      }
    };
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('textarea, input')) return;
      if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); go(1, 'key'); }
      else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); go(-1, 'key'); }
      else if (e.key === 'Escape') { setGate(null); setPanel(false); }
    };
    // [HF-REEL-OVERLAY-WEB-1] a click on YouTube's own sound icon puts keyboard focus inside the player iframe, which would swallow the arrow keys:
    // hand the focus straight back to the page.
    const unfocus = () => window.setTimeout(() => { const a = document.activeElement; if (a && a.tagName === 'IFRAME') (a as HTMLElement).blur(); }, 0);
    root.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', key);
    window.addEventListener('blur', unfocus);
    return () => { root.removeEventListener('wheel', wheel); window.removeEventListener('keydown', key); window.removeEventListener('blur', unfocus); };
  }, [go]);

  // ---- swipe up / down anywhere on the page (the black letterbox too), not only on the tap layer ----
  const onTouchStart = (e: React.TouchEvent) => { touchY.current = (e.target as HTMLElement).closest('.ex-panel, .ex-gate, .ex-rail, .ex-call, .ex-nav') ? null : (e.touches[0]?.clientY ?? null); };
  const onTouchEnd = (e: React.TouchEvent) => {
    const y0 = touchY.current; touchY.current = null;
    const y1 = e.changedTouches[0]?.clientY;
    if (y0 != null && y1 != null && Math.abs(y0 - y1) > 48) { e.preventDefault(); go(y0 > y1 ? 1 : -1, 'touch'); }
  };

  // ---- tap layer: play / pause (YouTube only; Instagram's middle belongs to Instagram's own player) ----
  const spec = cur ? playerFor(cur) : null;
  const tap = () => {
    if (!cur || !spec) return;
    if (spec.platform !== 'youtube') return;
    const el = frames.current[cur.id];
    if (paused) { ytCmd(el, 'playVideo'); setPaused(false); } else { ytCmd(el, 'pauseVideo'); setPaused(true); }
  };

  // ---- gated actions ----
  const needAuth = async (action: GateAction): Promise<boolean> => {
    if (signedIn) return true;
    let ok = false;
    if (!activeSessionSignedOut()) ok = !!(await getActiveTokenWaited(1500).catch(() => null));
    if (ok) { setSignedIn(true); return true; }
    capture('explore_signin_prompt', { action, reel_id: cur?.id });
    setGate(action);
    return false;
  };
  const failed = (code: string, status: number, id: string): void => {
    if (code === 'not_verified') { window.location.href = whatsappGateHref(`/r/${id}`); return; }
    if (status === 401 || code === 'no_session') { setSignedIn(false); setGate('like'); return; }
    say('Something went wrong. Please try again.');
  };
  const like = async () => {
    if (!cur || !(await needAuth('like'))) return;
    const id = cur.id;
    const was = liked[id] ?? cur.likedByMe === true;
    const base = likeN[id] ?? cur.likes;
    setLiked(l => ({ ...l, [id]: !was }));
    setLikeN(n => ({ ...n, [id]: Math.max(0, base + (was ? -1 : 1)) }));
    const r = await hfCall<{ ok: true; likes?: { total: number } }>(was ? 'DELETE' : 'POST', `/api/hf/reels/${id}/like`);
    if (!r.ok) { setLiked(l => ({ ...l, [id]: was })); setLikeN(n => ({ ...n, [id]: base })); failed(r.code, r.status, id); }
    else if (r.data.likes?.total != null) setLikeN(n => ({ ...n, [id]: r.data.likes!.total }));
  };
  const save = async () => {
    if (!cur || !(await needAuth('save'))) return;
    const id = cur.id;
    const was = saved[id] === true;
    setSaved(s => ({ ...s, [id]: !was }));
    const r = await hfCall(was ? 'DELETE' : 'PUT', `/api/hf/reel-bookmarks/${id}`);
    if (!r.ok) { setSaved(s => ({ ...s, [id]: was })); if (r.code === 'not_enabled') say('Saving reels opens soon.'); else failed(r.code, r.status, id); }
    else say(was ? 'Removed from saved' : 'Saved');
  };
  const loadComments = async (id: string) => {
    setComments(null); setCErr('');
    const r = await hfCall<{ ok: true; items: Comment[]; counts?: { comments?: { total?: number } } }>('GET', `/api/hf/reels/${id}/comments`, undefined, { auth: signedIn });
    if (live.current.items[live.current.idx]?.id !== id) return;
    if (r.ok) { setComments(r.data.items ?? []); const t = r.data.counts?.comments?.total; if (typeof t === 'number') setCommentN(n => ({ ...n, [id]: t })); }
    else { setComments([]); setCErr(r.code === 'not_enabled' ? 'Comments open soon.' : 'Could not load comments.'); }
  };
  const openComments = async () => {
    if (!cur) return;
    if (panel) { setPanel(false); return; }
    if (!(await needAuth('comment'))) return;
    setPanel(true);
    void loadComments(cur.id);
  };
  const post = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cur || posting || !text.trim()) return;
    setPosting(true); setCErr('');
    const id = cur.id;
    const r = await hfCall<{ ok: true; item: Comment; counts?: { comments?: { total?: number } } }>('POST', `/api/hf/reels/${id}/comments`, { body: text.trim() });
    setPosting(false);
    if (r.ok) {
      setText('');
      setComments(c => [r.data.item, ...(c ?? [])]);
      setCommentN(n => ({ ...n, [id]: r.data.counts?.comments?.total ?? (n[id] ?? cur.comments) + 1 }));
    } else if (r.code === 'not_verified') window.location.href = whatsappGateHref(`/r/${id}`);
    else if (r.status === 401) { setSignedIn(false); setGate('comment'); }
    else setCErr(r.message || (r.code === 'no_links' ? 'Links are not allowed in comments.' : 'Could not post your comment.'));
  };
  const share = async () => {
    if (!cur) return;
    const url = brandUrl(`/r/${cur.id}`);
    const w = whoOf(cur);
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    capture('explore_share', { reel_id: cur.id, method: coarse && typeof navigator.share === 'function' ? 'native' : 'copy' });
    if (coarse && typeof navigator.share === 'function') { try { await navigator.share({ url, title: w.name, text: cur.caption || w.name }); } catch { /* cancelled */ } return; }
    try { await navigator.clipboard.writeText(url); say('Link copied'); } catch { say(url); }
  };

  const slides = useMemo(() => [items[idx - 1], items[idx], items[idx + 1]].filter(Boolean) as ReelItem[], [items, idx]);
  if (!cur) return <p className="ex-empty">No reels to show yet. Please check back soon.</p>;
  const who = whoOf(cur);
  const isLiked = liked[cur.id] ?? cur.likedByMe === true;
  const gateCopy = gate ? GATE_COPY[gate] : null;
  const back = `/r/${cur.id}`;

  const isYt = spec?.platform === 'youtube';
  const isIg = spec?.platform === 'instagram';
  const ytBox = isYt ? sizeFor(size.w, size.h, 'youtube') : null;
  const callLabel = cur.kind === 'invite' ? 'Invite' : 'Call now';

  return <div className="ex-root" ref={rootRef} data-panel={panel ? '1' : undefined} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
    <div className="ex-stage">
      <div className="ex-wrap">
        <div className="ex-frame" ref={frameRef}>
          {slides.map(it => {
            const p = playerFor(it);
            if (!p) return null;
            const box = sizeFor(size.w, size.h, p.platform);
            const active = it.id === cur.id;
            const src = p.platform === 'youtube' ? p.src(it.id === items[0]?.id && active, origin) : p.src;
            return <div className="ex-slide" key={it.id} data-active={active ? '1' : undefined}>
              {it.thumbUrl && p.platform !== 'youtube' && <img className="ex-poster" src={it.thumbUrl} alt="" referrerPolicy="no-referrer" />}
              <iframe
                ref={el => { frames.current[it.id] = el; }}
                src={src} title="" loading="eager" tabIndex={-1} aria-hidden="true"
                allow="autoplay; encrypted-media; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin"
                onLoad={() => { yt.current[it.id] = { ready: false, state: -1, time: 0, warm: false, seen: false, hello: 0, tries: 0 }; setShown(m => { if (!m[it.id]) return m; const n = { ...m }; delete n[it.id]; return n; }); hello(it.id); drive(); }}
                style={{ width: box.width, height: box.height, left: box.left, top: box.top, pointerEvents: 'auto' }}
              />
              {/* [HF-EXPLORE-SMOOTH-1] YouTube: the poster sits ON TOP until the video really plays (no grey YouTube still) */}
              {it.thumbUrl && p.platform === 'youtube' && <img className="ex-poster" src={it.thumbUrl} alt="" referrerPolicy="no-referrer"
                style={{ width: box.width, height: box.height, left: box.left, top: box.top, inset: 'auto', zIndex: 1, pointerEvents: 'none', transition: 'opacity .2s', opacity: shown[it.id] ? 0 : 1 }} />}
            </div>;
          })}
          {isYt && ytBox && <>
            {/* the whole player box is ours (tap = play / pause) except the hole over YouTube's own sound icon */}
            <div className="ex-tap" role="button" tabIndex={0} aria-label={paused ? 'Play' : 'Pause'}
              style={{ left: ytBox.left, top: ytBox.top, width: ytBox.width, height: ytBox.height, clipPath: tapClipPath(ytBox.width, ytBox.height) }}
              onClick={tap} onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); tap(); } }} />
            {/* frosted patch: YouTube's own like / share are blurred behind our rail */}
            <div className="ex-frost" aria-hidden="true" style={{ right: Math.max(0, size.w - (ytBox.left + ytBox.width)) }} />
          </>}
          {paused && isYt && <div className="ex-playglyph" aria-hidden="true"><svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor"><path d="M8 5v14l11-7z" /></svg></div>}
          {isIg && <>
            <div className="ex-igshade" aria-hidden="true" />
            <div className="ex-iglabel" aria-hidden="true">{Icon.igMark}<span>Instagram</span></div>
            <div className="ex-igmeta" aria-hidden="true">
              <div className="ex-igwho">
                <span className="ex-igpic">{who.avatar ? <img src={who.avatar} alt="" referrerPolicy="no-referrer" /> : <span>{who.name.slice(0, 1).toUpperCase()}</span>}</span>
                <span className="ex-igname">{who.name}</span>
              </div>
              {cur.caption && <p className="ex-igcap">{cur.caption}</p>}
            </div>
            {/* swipe-only strips: Instagram's own player owns everything between them */}
            <div className="ex-igstrip" data-pos="top" aria-hidden="true" />
            <div className="ex-igstrip" data-pos="bottom" aria-hidden="true" />
          </>}
        </div>
        <a className="ex-call" href={who.href} onClick={() => capture('explore_call_tap', { reel_id: cur.id, kind: cur.kind === 'invite' ? 'invite' : 'network' })}>{cur.kind === 'invite' ? Icon.plus : Icon.phone}<span>{callLabel}</span></a>
        <div className="ex-rail" data-platform={spec?.platform}>
          <button type="button" className="ex-act" aria-label="Comments" onClick={openComments}>{Icon.comment}<b>{compactCount(commentN[cur.id] ?? cur.comments)}</b></button>
          <button type="button" className="ex-act" data-on={saved[cur.id] ? '1' : undefined} aria-pressed={saved[cur.id] === true} aria-label="Save" onClick={save}>{Icon.save(saved[cur.id] === true)}<b>Save</b></button>
          <button type="button" className="ex-act" data-on={isLiked ? '1' : undefined} aria-pressed={isLiked} aria-label="Like" onClick={like}>{isYt ? Icon.thumb(isLiked) : Icon.heart(isLiked)}<b>{compactCount(likeN[cur.id] ?? cur.likes)}</b></button>
          <button type="button" className="ex-act" aria-label="Share" onClick={share}>{isYt ? Icon.ytShare : Icon.plane}<b>Share</b></button>
        </div>
      </div>
      <div className="ex-nav">
        <button type="button" aria-label="Previous reel" disabled={idx === 0} onClick={() => go(-1, 'button')}>{Icon.up}</button>
        <button type="button" aria-label="Next reel" disabled={idx >= items.length - 1 && !cursor} onClick={() => go(1, 'button')}>{Icon.down}</button>
      </div>
    </div>

    {panel && <aside className="ex-panel" aria-label="Comments">
      <header><h2>Comments</h2><button type="button" aria-label="Close comments" onClick={() => setPanel(false)}>{Icon.close}</button></header>
      <div className="ex-clist">
        {comments === null && <p className="ex-cnote">Loading...</p>}
        {comments?.length === 0 && !cErr && <p className="ex-cnote">No comments yet. Say hello!</p>}
        {comments?.map(c => <div className="ex-comment" key={c.id}><b>{c.author.name || 'Someone'}</b><span>{ago(c.createdAt)}</span><p>{c.body}</p></div>)}
      </div>
      {cErr && <p className="ex-cerr" role="alert">{cErr}</p>}
      <form onSubmit={post}>
        <textarea value={text} onChange={e => setText(e.target.value)} maxLength={500} rows={2} placeholder="Add a comment..." aria-label="Add a comment" />
        <button type="submit" disabled={posting || !text.trim()}>Post</button>
      </form>
    </aside>}

    {gateCopy && <div className="ex-gate" role="dialog" aria-modal="true" aria-label={gateCopy.title} onClick={e => { if (e.target === e.currentTarget) setGate(null); }}>
      <div className="ex-card">
        <button type="button" className="ex-x" aria-label="Close" onClick={() => setGate(null)}>{Icon.close}</button>
        <div className="ex-cphoto">{who.avatar ? <img src={who.avatar} alt="" referrerPolicy="no-referrer" /> : <span>{who.name.slice(0, 1).toUpperCase()}</span>}</div>
        <h2>{gateCopy.title}</h2>
        <p>{gateCopy.line}</p>
        <a className="ex-b-wa" href={signInHref(back)}>Continue with WhatsApp</a>
        <a className="ex-b-g" href={signInHref(back, true)}>Continue with Google</a>
        <small>New or returning, the same button signs you in.</small>
      </div>
    </div>}
    {toast && <div className="ex-toast" role="status">{toast}</div>}
  </div>;
}
