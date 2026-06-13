// SessionRoom — the AvaVision split-screen live vision session island.
//
// Mirrors web-client Phase E's AgentCall (auth gate → calls/now → sessions/start →
// open Gemini Live WS directly → two-way Web Audio → 1-fps frame sender → heartbeat
// → stop) and ADDS the AvaVision layer: the on-device camera + MediaPipe/MoveNet
// overlay + live score badge (visionEngineWeb, free, never streamed) and the
// "Analyze my form" snapshot (the only new cloud media path).
//
// Three vision layers (MASTER §2): Gemini Live sees ~1 fps LOW (coarse coach),
// the on-device engine draws the overlay + score at ~30 fps (free), and the
// snapshot does the pixel-grounded deep review on demand. The Worker enforces
// billing / concurrency / caps; we react to its 402 / 409 / 503 / 429.
//
// Safety (MASTER rule 10): explicit per-session camera consent BEFORE getUserMedia,
// a persistent "the agent can see you" indicator while live, technique-only scoring.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClerkIsland, useAuthToken } from '../../../lib/clerk';
import { ApiError } from '../../../lib/apiClient';
import { Avatar } from '../../../components/Avatar';
import { Button } from '../../../components/Button';
import { Spinner } from '../../../components/Spinner';
import { Pill } from '../../../components/Pill';
import {
  callNow,
  fmtCoins,
  getAgent,
  isFreeForCallers,
  rateLabel,
  sessionHeartbeat,
  sessionStart,
  sessionStop,
  snapshot as snapshotCall,
  type Capability,
  type OverlayStyle,
  type ScoringMode,
  type SnapshotResult,
  type VisionAgent,
  type VisionTicket,
} from './avavisionApi';
import { GeminiLiveClient } from './GeminiLiveClient';
import { AudioPipeline } from './AudioPipeline';
import { VisionEngineWeb, dataUrlToArrayBuffer } from './visionEngineWeb';
import { SnapshotSheet } from './SnapshotSheet';

/** SSR-provided agent summary for instant first paint (may be partial/null). */
export interface VisionAgentSeed {
  id: string;
  name?: string | null;
  role?: string | null;
  avatarUrl?: string | null;
  payerMode?: string | null;
  ratePerHourCoins?: number | null;
  capability?: Capability | null;
  overlayStyle?: OverlayStyle | null;
  scoringMode?: ScoringMode | null;
  scoreLabel?: string | null;
  agenticSnapshotEnabled?: boolean | null;
  busy?: boolean | null;
}

interface Props {
  agentId: string;
  seed?: VisionAgentSeed | null;
}

type Phase = 'idle' | 'authing' | 'starting' | 'connecting' | 'live' | 'wrapup' | 'ended' | 'error';

const LANGS: Array<[string, string]> = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['es-ES', 'Spanish'],
  ['pt-BR', 'Portuguese (BR)'],
  ['fr-FR', 'French'],
  ['de-DE', 'German'],
  ['hi-IN', 'Hindi'],
  ['ar-XA', 'Arabic'],
  ['ja-JP', 'Japanese'],
  ['ko-KR', 'Korean'],
  ['cmn-CN', 'Mandarin'],
];

function defaultLang(): string {
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  const hit = LANGS.find(([c]) => c.toLowerCase() === nav.toLowerCase() || c.split('-')[0] === nav.split('-')[0]);
  return hit?.[0] ?? 'en-US';
}

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const CUE_EVERY_MS = 5000; // throttle Live system cues independent of the badge

function SessionRoomInner({ agentId, seed }: Props) {
  const auth = useAuthToken();

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<string>(defaultLang());
  const [consent, setConsent] = useState(false);

  const [agent, setAgent] = useState<VisionAgent | null>(null);
  const name = agent?.name ?? seed?.name ?? 'AI vision coach';
  const role = agent?.role ?? seed?.role ?? '';
  const avatarUrl = agent?.avatarUrl ?? seed?.avatarUrl ?? null;
  const free = agent
    ? isFreeForCallers(agent)
    : (seed?.payerMode ?? 'user_pays') === 'creator_pays';
  const priceText = agent
    ? rateLabel(agent)
    : free
      ? 'Free to call'
      : seed?.ratePerHourCoins != null
        ? `${fmtCoins(seed.ratePerHourCoins)}/hr`
        : null;

  // live session config (from the ticket)
  const [scoreLabel, setScoreLabel] = useState<string>(seed?.scoreLabel ?? 'Score');
  const [snapshotEnabled, setSnapshotEnabled] = useState<boolean>(seed?.agenticSnapshotEnabled ?? false);
  const [freeSnapshots, setFreeSnapshots] = useState<number>(0);

  const [muted, setMuted] = useState(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [caption, setCaption] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [limitMin, setLimitMin] = useState(30);
  const [score, setScore] = useState<number | null>(null);

  // snapshot state
  const [snapOpen, setSnapOpen] = useState(false);
  const [snapLoading, setSnapLoading] = useState(false);
  const [snapCap, setSnapCap] = useState(false);
  const [snapResult, setSnapResult] = useState<SnapshotResult | null>(null);
  const [snapError, setSnapError] = useState<string | null>(null);
  const [snapsUsed, setSnapsUsed] = useState(0);

  // DOM + engine refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<VisionEngineWeb | null>(null);
  const liveRef = useRef<GeminiLiveClient | null>(null);
  const audioRef = useRef<AudioPipeline | null>(null);
  const sessionRef = useRef<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const tickRef = useRef<number | null>(null);
  const beatRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastCueRef = useRef(0);
  const lastWrapCueRef = useRef(-1);
  const endedRef = useRef(false);

  const remainingSnaps = snapshotEnabled ? Math.max(0, freeSnapshots - snapsUsed) : null;

  // ── teardown ────────────────────────────────────────────────────────────────
  const teardown = useCallback(() => {
    if (tickRef.current != null) { clearInterval(tickRef.current); tickRef.current = null; }
    if (beatRef.current != null) { clearInterval(beatRef.current); beatRef.current = null; }
    if (frameRef.current != null) { clearInterval(frameRef.current); frameRef.current = null; }
    liveRef.current?.close(); liveRef.current = null;
    engineRef.current?.stop(); engineRef.current = null;
    void audioRef.current?.dispose(); audioRef.current = null;
  }, []);

  const endSession = useCallback(
    async (reason: string, asError?: string) => {
      if (endedRef.current) return;
      endedRef.current = true;
      teardown();
      const sid = sessionRef.current;
      const jwt = tokenRef.current;
      sessionRef.current = null;
      if (sid && jwt) await sessionStop(sid, jwt, reason).catch(() => undefined); // idempotent (§B)
      setPhase(asError ? 'error' : 'ended');
      if (asError) setError(asError);
    },
    [teardown],
  );

  // Stop on tab close (don't strand billing). Fire-and-forget; server idempotent.
  useEffect(() => {
    const onUnload = () => {
      const sid = sessionRef.current;
      const jwt = tokenRef.current;
      if (!sid || !jwt) return;
      try {
        const blob = new Blob([JSON.stringify({ session_id: sid, reason: 'unload' })], { type: 'application/json' });
        navigator.sendBeacon?.(
          `${import.meta.env.PUBLIC_API_BASE ?? 'https://api.avatok.ai'}/api/avavision/sessions/stop`,
          blob,
        );
      } catch {
        /* best effort */
      }
    };
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('pagehide', onUnload);
      teardown();
    };
  }, [teardown]);

  // ── connect Gemini Live + start mic, overlay, and the 1-fps frame sender ───────
  const connectGemini = useCallback(
    async (ticket: VisionTicket) => {
      const audio = new AudioPipeline({
        onMicChunk: (pcm) => liveRef.current?.sendAudio(pcm),
        onAgentSpeaking: setAgentSpeaking,
      });
      audioRef.current = audio;

      const live = new GeminiLiveClient(ticket.geminiToken, ticket.model, {
        onReady: async () => {
          try {
            await audio.resumeOutput();
            await audio.startMic();
            // start the 1-fps LOW frame stream to the Live model
            frameRef.current = window.setInterval(() => {
              const url = engineRef.current?.grabLowResFrame();
              if (url) liveRef.current?.sendVideoFrame(dataUrlToArrayBuffer(url));
            }, 1000);
            setPhase('live');
          } catch {
            await endSession('mic_denied', 'Microphone access is needed to talk. Allow it and try again.');
          }
        },
        onAudio: (pcm) => audio.playChunk(pcm),
        onTranscript: setCaption,
        onInterrupted: () => audio.clearPlayback(),
        onClose: (clean) => {
          if (endedRef.current) return;
          void endSession('gemini_closed', clean ? undefined : 'The session dropped. Please start again.');
        },
      });
      liveRef.current = live;
      setPhase('connecting');
      live.connect();
    },
    [endSession],
  );

  // ── start the camera + on-device engine, then connect Gemini ───────────────────
  const startEngine = useCallback(async (ticket: VisionTicket) => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) throw new Error('no_surface');
    const engine = new VisionEngineWeb({
      capability: ticket.capability,
      engine: ticket.engine,
      overlayStyle: ticket.overlayStyle,
      scoringMode: ticket.scoringMode,
      scoreLabel: ticket.scoreLabel,
      mirrored: true,
    });
    engine.onScore((s, hint) => {
      if (s != null) setScore(s);
      // push a grounding cue to Live, throttled (badge updates faster than cues)
      const now = performance.now();
      if (now - lastCueRef.current >= CUE_EVERY_MS && liveRef.current?.isReady) {
        lastCueRef.current = now;
        const bits: string[] = [];
        if (s != null) bits.push(`${ticket.scoreLabel} ${s}`);
        if (hint) bits.push(hint);
        if (bits.length) liveRef.current.sendSystemCue(`[SYSTEM: ${bits.join(', ')}]`);
      }
    });
    engineRef.current = engine;
    await engine.start(v, c); // triggers getUserMedia (consent already granted)
  }, []);

  const start = useCallback(async () => {
    setError(null);
    endedRef.current = false;
    setScore(null);
    setSnapsUsed(0);
    setPhase('authing');

    let jwt: string;
    try {
      jwt = await auth.require();
    } catch {
      setPhase('idle');
      return;
    }
    tokenRef.current = jwt;

    try {
      const full = await getAgent(agentId, jwt);
      if (full) {
        setAgent(full);
        setScoreLabel(full.scoreLabel);
        setSnapshotEnabled(full.agenticSnapshotEnabled);
      }
    } catch {
      /* non-fatal: fall back to the SSR seed */
    }

    setPhase('starting');
    try {
      const now = await callNow(agentId, language, jwt);
      if (now.status !== 200 || !now.body?.call_id) return void mapStartError(now.status, now.error);

      const started = await sessionStart({ callId: now.body.call_id, language }, jwt);
      if (started.status !== 200 || !started.ticket) return void mapStartError(started.status, started.error);

      const t = started.ticket;
      sessionRef.current = t.sessionId;
      setScoreLabel(t.scoreLabel);
      setSnapshotEnabled(t.agenticSnapshotEnabled);
      setFreeSnapshots(t.freeSnapshotsPerSession);
      setLimitMin(Math.max(1, Math.min(60, t.limitMinutes)));
      setElapsed(0);

      // camera + overlay first so the user sees themselves immediately
      await startEngine(t);

      // countdown + wrap-up + hard cap (mirrors Phase E)
      tickRef.current = window.setInterval(() => {
        setElapsed((e) => {
          const next = e + 1;
          const remaining = Math.min(60, t.limitMinutes) * 60 - next;
          if (remaining <= 120 && remaining > 0) {
            setPhase((p) => (p === 'live' ? 'wrapup' : p));
            // one-shot exact wrap-up cue to Live (MASTER §5)
            const mins = Math.ceil(remaining / 60);
            if (mins !== lastWrapCueRef.current && liveRef.current?.isReady) {
              lastWrapCueRef.current = mins;
              liveRef.current.sendSystemCue(`[SYSTEM: ${mins} minute${mins === 1 ? '' : 's'} remaining]`);
            }
          }
          if (remaining <= 0) void endSession('hard_cap');
          return next;
        });
      }, 1000);

      // billing heartbeat
      beatRef.current = window.setInterval(async () => {
        const sid = sessionRef.current;
        if (!sid) return;
        const r = await sessionHeartbeat(sid, jwt);
        if (r.status === 402) return void endSession('insufficient_avacoins', 'Your AvaCoins ran out — the session ended.');
        if (r.body?.ended === true) return void endSession('server');
      }, Math.max(15, t.beatEverySec) * 1000);

      await connectGemini(t);
    } catch (e) {
      if (e instanceof Error && e.message === 'no_surface') {
        return void mapStartError(0, 'Could not open the camera view. Reload and try again.');
      }
      // getUserMedia rejection (camera denied) lands here
      if (e instanceof DOMException) {
        return void mapStartError(0, 'Camera access is needed for a vision session. Allow it and try again.');
      }
      const status = e instanceof ApiError ? e.status : 0;
      mapStartError(status, e instanceof ApiError ? e.error : 'network');
    }

    function mapStartError(status: number, err?: string) {
      teardown();
      sessionRef.current = null;
      setPhase('error');
      setError(
        status === 402
          ? 'Not enough AvaCoins to start this session. Top up your wallet and try again.'
          : status === 409
            ? err === 'too early'
              ? 'This session has not started yet.'
              : `${name} is busy on all lines — please try again shortly.`
            : status === 503
              ? 'Vision agents are temporarily unavailable.'
              : err || 'Could not connect. Please try again.',
      );
    }
  }, [agentId, auth, language, name, connectGemini, startEngine, endSession, teardown]);

  // ── controls ──────────────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    setMuted((m) => {
      audioRef.current?.setMuted(!m);
      return !m;
    });
  }, []);

  const onHangup = useCallback(() => {
    if (phase === 'ended' || phase === 'error') {
      endedRef.current = false;
      setPhase('idle');
      setError(null);
      setCaption('');
      setScore(null);
      return;
    }
    void endSession('user');
  }, [phase, endSession]);

  const analyze = useCallback(async () => {
    const sid = sessionRef.current;
    const jwt = tokenRef.current;
    const url = engineRef.current?.grabHiResFrame();
    if (!sid || !jwt || !url) return;
    setSnapOpen(true);
    setSnapLoading(true);
    setSnapCap(false);
    setSnapError(null);
    setSnapResult(null);
    const i = url.indexOf(',');
    const b64 = i >= 0 ? url.slice(i + 1) : url;
    const r = await snapshotCall(sid, b64, jwt);
    setSnapLoading(false);
    if (r.capReached) {
      setSnapCap(true);
      setSnapsUsed((u) => Math.max(u, freeSnapshots));
    } else if (r.status === 200 && r.result) {
      setSnapResult(r.result);
      setSnapsUsed((u) => u + 1);
    } else {
      setSnapError(r.error || 'Could not analyze that frame. Try again.');
    }
  }, [freeSnapshots]);

  // ── render ──────────────────────────────────────────────────────────────────
  const liveish = phase === 'live' || phase === 'wrapup';
  const inFlight = phase === 'authing' || phase === 'starting' || phase === 'connecting';
  const remaining = Math.max(0, Math.min(60, limitMin) * 60 - elapsed);
  const billedMin = Math.ceil(elapsed / 60);
  const canAnalyze = liveish && snapshotEnabled && !snapLoading && (remainingSnaps ?? 0) > 0;

  // The video + canvas surface must be mounted before start() so refs exist.
  const stageVisible = inFlight || liveish;

  const langPicker = useMemo(
    () => (
      <label className="flex w-full max-w-xs flex-col gap-1.5">
        <span className="font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">Coach in</span>
        <select
          className="w-full rounded-zineField border-zine border-ink bg-card px-3.5 py-2.5 font-body font-bold text-[15px] text-ink shadow-zine-xs focus:outline-none"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          {LANGS.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </label>
    ),
    [language],
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6">
      {/* Identity */}
      <div className="flex flex-col items-center gap-3 text-center">
        <div
          className={[
            'rounded-full border-zine border-ink bg-lilac p-1.5 shadow-zine',
            agentSpeaking ? 'ring-4 ring-lilac' : '',
          ].join(' ')}
        >
          <Avatar src={avatarUrl} name={name} size={92} fallbackClassName="bg-lilac" />
        </div>
        <h1 className="font-display font-semibold text-[26px] leading-tight text-ink">{name}</h1>
        {role && <p className="max-w-md font-body font-bold text-[14px] text-inkSoft">{role}</p>}
        {priceText && (
          <span className="inline-flex items-center rounded-full border-zine border-ink bg-card px-3 py-1 font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-ink shadow-zine-xs">
            {priceText}
          </span>
        )}
      </div>

      {/* IDLE — consent + language + start */}
      {phase === 'idle' && (
        <div className="flex w-full flex-col items-center gap-4">
          {langPicker}
          <label className="flex max-w-md cursor-pointer items-start gap-2.5 rounded-zine border-zine border-ink bg-card px-4 py-3 shadow-zine-xs">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5 accent-[var(--zine-blueInk)]"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span className="font-body font-bold text-[13px] leading-snug text-ink">
              I agree to turn on my camera for this session. {name} sees a low-detail view (~1 frame/sec) to
              coach my technique. The skeleton/overlay runs only on my device and is never uploaded.
            </span>
          </label>
          <Button variant="lime" fullWidth label="Start vision session" disabled={!consent} onClick={start} />
          <p className="max-w-md text-center font-body text-[12px] text-inkMute">
            {free
              ? 'Free — the creator covers it. Camera + mic access required.'
              : 'Billed per minute from your AvaWallet. Camera + mic access required.'}
          </p>
        </div>
      )}

      {inFlight && (
        <div className="flex flex-col items-center gap-3 py-2">
          <Spinner size={28} color="var(--zine-lilac)" />
          <span className="font-mono font-bold uppercase text-[12px] tracking-[0.08em] text-inkSoft">
            {phase === 'authing' ? 'verifying…' : phase === 'starting' ? 'starting session…' : 'connecting…'}
          </span>
        </div>
      )}

      {/* STAGE — split screen: camera + overlay + score badge, agent thumbnail */}
      {stageVisible && (
        <div className="relative w-full overflow-hidden rounded-zine border-zine border-ink bg-ink shadow-zine">
          <div className="relative aspect-[3/4] w-full sm:aspect-video">
            {/* mirrored selfie view */}
            <video
              ref={videoRef}
              className="absolute inset-0 h-full w-full object-cover"
              style={{ transform: 'scaleX(-1)' }}
              playsInline
              muted
            />
            <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ transform: 'scaleX(-1)' }} />

            {/* score badge (transparent, technique-only) */}
            {liveish && score != null && (
              <div className="absolute left-3 top-3">
                <span className="inline-flex items-center gap-2 rounded-full border-zine border-ink bg-lime/90 px-3 py-1 font-mono font-bold uppercase text-[13px] tracking-[0.06em] text-ink shadow-zine-xs">
                  {scoreLabel} {score}
                </span>
              </div>
            )}

            {/* "the agent can see you" persistent indicator */}
            {liveish && (
              <div className="absolute right-3 top-3">
                <Pill kind="no" icon="●">{name} can see you</Pill>
              </div>
            )}

            {/* agent avatar thumbnail */}
            <div className="absolute bottom-3 right-3">
              <div
                className={[
                  'rounded-full border-zine border-ink bg-lilac p-1 shadow-zine-sm',
                  agentSpeaking ? 'ring-4 ring-lime' : '',
                ].join(' ')}
              >
                <Avatar src={avatarUrl} name={name} size={56} fallbackClassName="bg-lilac" />
              </div>
            </div>

            {/* status sticker */}
            {liveish && (
              <div className="absolute bottom-3 left-3">
                <span
                  className={[
                    'inline-flex items-center gap-2 rounded-full border-zine border-ink px-3 py-1 shadow-zine-xs',
                    'font-mono font-bold uppercase text-[11px] tracking-[0.08em]',
                    agentSpeaking ? 'bg-lilac text-ink' : 'bg-card text-inkSoft',
                  ].join(' ')}
                >
                  {agentSpeaking ? '● speaking' : phase === 'wrapup' ? 'wrapping up' : 'listening'}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* caption */}
      {liveish && caption && (
        <p className="min-h-[2em] max-w-lg text-center font-body font-bold text-[15px] leading-snug text-ink">
          {caption}
        </p>
      )}

      {/* live controls */}
      {liveish && (
        <div className="flex flex-col items-center gap-4">
          <span
            className={[
              'inline-flex items-center gap-2 rounded-full border-zine border-ink px-3.5 py-1.5 shadow-zine-xs',
              phase === 'wrapup' ? 'bg-coral text-white' : 'bg-card text-ink',
              'font-mono font-bold uppercase text-[12px] tracking-[0.08em]',
            ].join(' ')}
          >
            ⏱ -{fmtClock(remaining)}
          </span>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
              onClick={toggleMute}
              className={[
                'inline-flex h-[52px] w-[52px] items-center justify-center rounded-full border-zine border-ink shadow-zine-xs',
                'active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed',
                muted ? 'bg-lime text-ink' : 'bg-card text-ink',
              ].join(' ')}
            >
              <span className="text-[20px] leading-none">{muted ? '🔇' : '🎙'}</span>
            </button>

            {snapshotEnabled && (
              <button
                type="button"
                onClick={() => void analyze()}
                disabled={!canAnalyze}
                className={[
                  'inline-flex items-center gap-2 rounded-full border-zine border-ink px-4 py-3 shadow-zine-xs',
                  'font-mono font-bold uppercase text-[12px] tracking-[0.08em]',
                  'active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed disabled:opacity-50',
                  'bg-blue text-ink',
                ].join(' ')}
              >
                {snapLoading ? <Spinner size={16} color="var(--zine-ink)" /> : '🔍'} Analyze my form
                {remainingSnaps != null && remainingSnaps > 0 && (
                  <span className="rounded-full bg-ink px-1.5 text-[10px] text-paper">{remainingSnaps}</span>
                )}
              </button>
            )}

            <button
              type="button"
              aria-label="End session"
              onClick={onHangup}
              className="inline-flex h-16 w-16 items-center justify-center rounded-full border-zine border-ink bg-coral text-white shadow-zine-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed"
            >
              <span className="text-[24px] leading-none">📞</span>
            </button>
          </div>
        </div>
      )}

      {/* ended / error */}
      {(phase === 'ended' || phase === 'error') && (
        <div className="flex w-full max-w-md flex-col items-center gap-3">
          <div className="flex w-full flex-col items-center gap-2 rounded-zine border-zine border-ink bg-card p-5 text-center shadow-zine-sm">
            <span className="font-display font-semibold text-[19px] text-ink">
              {phase === 'error' ? 'Could not connect' : 'Session ended'}
            </span>
            {phase === 'error' ? (
              <p className="font-body font-bold text-[14px] text-coral">{error}</p>
            ) : (
              <p className="font-body font-bold text-[14px] text-inkSoft">
                You trained with {name} for {fmtClock(elapsed)}.
                {!free && agent ? ` Billed ~${billedMin} min; unused escrow is refunded.` : ' This session was free.'}
              </p>
            )}
          </div>
          <Button variant="lime" fullWidth label={phase === 'error' ? 'Try again' : 'Start another session'} onClick={onHangup} />
        </div>
      )}

      {snapshotEnabled && (
        <SnapshotSheet
          open={snapOpen}
          loading={snapLoading}
          capReached={snapCap}
          result={snapResult}
          error={snapError}
          scoreLabel={scoreLabel}
          remainingSnapshots={remainingSnaps}
          onClose={() => setSnapOpen(false)}
        />
      )}
    </div>
  );
}

/** Exported island — wraps the Clerk/GuestGate host so requireGuestAuth works. */
export default function SessionRoom(props: Props) {
  return (
    <ClerkIsland>
      <SessionRoomInner {...props} />
    </ClerkIsland>
  );
}
