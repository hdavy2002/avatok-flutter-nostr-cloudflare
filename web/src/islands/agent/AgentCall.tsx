// AgentCall — the AvaVoice agent-call island for /agent/<id>.
//
// Flow (MASTER-PROMPT §4b gating + worker/src/routes/avavoice.ts contract):
//   1. Page loads PUBLIC & ungated; this island shows the agent card + "Talk now".
//   2. Tap "Talk now" → requireGuestAuth() (Phase 0): existing session resolves
//      immediately, else the GuestGate (email→OTP→guest) mints a JWT.
//   3. With the JWT: POST /calls/now (agent_id) → { call_id }, then
//      POST /sessions/start (call_id) → { ephemeral Gemini token, sessionId,
//      model, limit_minutes, vision_enabled, beat_every_sec }.
//   4. Open the Gemini Live WS DIRECTLY from the browser with the ephemeral
//      token; stream mic up (16 kHz PCM16) and play agent audio down (24 kHz).
//      Vision agents also send low-FPS camera/screen frames.
//   5. Heartbeat on beat_every_sec; on hang-up / hard cap / busy → sessions/stop,
//      close WS, tear down audio, show the "call ended" card.
//
// The Worker enforces billing / concurrency / hard caps — we just react to its
// 402 (insufficient Tokens), 409 (AGENT_BUSY / too early), and 503 (disabled).

import { useCallback, useEffect, useRef, useState } from 'react';
import { ClerkIsland, useAuthToken } from '../../lib/clerk';
import { ApiError } from '../../lib/apiClient';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Spinner } from '../../components/Spinner';
import {
  callNow,
  fmtCoins,
  getAgent,
  isFreeForCallers,
  rateLabel,
  sessionHeartbeat,
  sessionStart,
  sessionStop,
  type SessionTicket,
  type VoiceAgent,
} from './api';
import { GeminiLiveClient } from './GeminiLiveClient';
import { AudioPipeline } from './AudioPipeline';
import { VisionSender, type VisionSource } from './VisionSender';
import { CallControls, type CallPhase } from './CallControls';

/** SSR-provided agent summary for instant first paint (may be partial/null). */
export interface AgentSeed {
  id: string;
  name?: string | null;
  role?: string | null;
  avatarUrl?: string | null;
  payerMode?: string | null;
  ratePerHourCoins?: number | null;
  visionEnabled?: boolean | null;
  busy?: boolean | null;
}

interface Props {
  agentId: string;
  seed?: AgentSeed | null;
}

// A small, friendly subset of Gemini Live output languages (full set lives in
// the app's kVoiceLanguages). Default follows the browser when possible.
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
  const hit = LANGS.find(([code]) => code.toLowerCase() === nav.toLowerCase() || code.split('-')[0] === nav.split('-')[0]);
  return hit?.[0] ?? 'en-US';
}

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function AgentCallInner({ agentId, seed }: Props) {
  const auth = useAuthToken();

  const [phase, setPhase] = useState<CallPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<string>(defaultLang());

  // Full agent (fetched authed after the gate); falls back to the SSR seed.
  const [agent, setAgent] = useState<VoiceAgent | null>(null);
  const visionEnabled = agent?.visionEnabled ?? seed?.visionEnabled ?? false;
  const name = agent?.name ?? seed?.name ?? 'AI voice agent';
  const role = agent?.role ?? seed?.role ?? '';
  const avatarUrl = agent?.avatarUrl ?? seed?.avatarUrl ?? null;
  const free =
    (agent ? isFreeForCallers(agent) : (seed?.payerMode ?? 'user_pays') === 'creator_pays');
  const priceText = agent
    ? rateLabel(agent)
    : free
      ? 'Free to call'
      : seed?.ratePerHourCoins != null
        ? `${fmtCoins(seed.ratePerHourCoins)}/hr`
        : null;

  const [muted, setMuted] = useState(false);
  const [visionOn, setVisionOn] = useState(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [caption, setCaption] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [limitMin, setLimitMin] = useState(60);

  // Mutable engine refs (don't trigger re-render).
  const liveRef = useRef<GeminiLiveClient | null>(null);
  const audioRef = useRef<AudioPipeline | null>(null);
  const visionRef = useRef<VisionSender | null>(null);
  const sessionRef = useRef<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const tickRef = useRef<number | null>(null);
  const beatRef = useRef<number | null>(null);
  const endedRef = useRef(false);

  // ── teardown ────────────────────────────────────────────────────────────
  const teardown = useCallback(() => {
    if (tickRef.current != null) { clearInterval(tickRef.current); tickRef.current = null; }
    if (beatRef.current != null) { clearInterval(beatRef.current); beatRef.current = null; }
    liveRef.current?.close(); liveRef.current = null;
    void visionRef.current?.stop(); visionRef.current = null;
    void audioRef.current?.dispose(); audioRef.current = null;
  }, []);

  const endCall = useCallback(
    async (reason: string, asError?: string) => {
      if (endedRef.current) return;
      endedRef.current = true;
      teardown();
      const sid = sessionRef.current;
      const jwt = tokenRef.current;
      sessionRef.current = null;
      if (sid && jwt) await sessionStop(sid, jwt, reason).catch(() => undefined);
      setPhase(asError ? 'error' : 'ended');
      if (asError) setError(asError);
    },
    [teardown],
  );

  // Stop the call if the tab is closed mid-session (don't strand billing).
  useEffect(() => {
    const onUnload = () => {
      const sid = sessionRef.current;
      const jwt = tokenRef.current;
      if (!sid || !jwt) return;
      try {
        const blob = new Blob([JSON.stringify({ session_id: sid, reason: 'unload' })], { type: 'application/json' });
        navigator.sendBeacon?.(`${import.meta.env.PUBLIC_API_BASE ?? 'https://api.avatok.ai'}/api/avavoice/sessions/stop`, blob);
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

  // ── the call ──────────────────────────────────────────────────────────────
  const connectGemini = useCallback(
    async (ticket: SessionTicket) => {
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
            setPhase('live');
          } catch {
            await endCall('mic_denied', 'Microphone access is needed to talk. Allow it and try again.');
          }
        },
        onAudio: (pcm) => audio.playChunk(pcm),
        onTranscript: setCaption,
        onInterrupted: () => audio.clearPlayback(),
        onClose: (clean) => {
          // Gemini live sockets cap ~10 min. Within the billed window this is
          // unexpected → end gracefully (no token-refresh endpoint for avavoice).
          if (endedRef.current) return;
          void endCall('gemini_closed', clean ? undefined : 'The call dropped. Please start again.');
        },
      });
      liveRef.current = live;
      setPhase('connecting');
      live.connect();
    },
    [endCall],
  );

  const start = useCallback(async () => {
    setError(null);
    endedRef.current = false;
    setPhase('authing');
    let jwt: string;
    try {
      jwt = await auth.require(); // opens GuestGate only if no session
    } catch {
      setPhase('idle'); // user dismissed the gate
      return;
    }
    tokenRef.current = jwt;

    // Authoritative agent config (vision / busy / price) for the call.
    try {
      const full = await getAgent(agentId, jwt);
      if (full) setAgent(full);
    } catch {
      /* non-fatal: fall back to the SSR seed */
    }

    setPhase('starting');
    try {
      const now = await callNow(agentId, language, jwt);
      if (now.status !== 200 || !now.body?.call_id) {
        return void mapStartError(now.status, now.error);
      }
      const started = await sessionStart({ callId: now.body.call_id, language }, jwt);
      if (started.status !== 200 || !started.ticket) {
        return void mapStartError(started.status, started.error);
      }
      const t = started.ticket;
      sessionRef.current = t.sessionId;
      setLimitMin(Math.max(1, Math.min(60, t.limitMinutes)));
      setElapsed(0);

      // local countdown + the worker hard-cap mirror
      tickRef.current = window.setInterval(() => {
        setElapsed((e) => {
          const next = e + 1;
          const remaining = Math.min(60, t.limitMinutes) * 60 - next;
          if (remaining <= 120 && remaining > 0) setPhase((p) => (p === 'live' ? 'wrapup' : p));
          if (remaining <= 0) void endCall('hard_cap');
          return next;
        });
      }, 1000);
      // billing heartbeat
      beatRef.current = window.setInterval(async () => {
        const sid = sessionRef.current;
        if (!sid) return;
        const r = await sessionHeartbeat(sid, jwt);
        if (r.status === 402) return void endCall('insufficient_avacoins', 'Your Tokens ran out — the call ended.');
        if (r.body?.ended === true) return void endCall('server');
      }, Math.max(15, t.beatEverySec) * 1000);

      await connectGemini(t);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      mapStartError(status, e instanceof ApiError ? e.error : 'network');
    }

    function mapStartError(status: number, err?: string) {
      teardown();
      sessionRef.current = null;
      setPhase('error');
      setError(
        status === 402
          ? 'Not enough Tokens to start this call. Top up your wallet and try again.'
          : status === 409
            ? err === 'too early'
              ? 'This session has not started yet.'
              : `${name} is busy on all lines — please try again shortly.`
            : status === 503
              ? 'Voice agents are temporarily unavailable.'
              : err || 'Could not connect. Please try again.',
      );
    }
  }, [agentId, auth, language, name, connectGemini, endCall, teardown]);

  // ── controls ──────────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    setMuted((m) => {
      audioRef.current?.setMuted(!m);
      return !m;
    });
  }, []);

  const toggleVision = useCallback(async () => {
    if (!visionEnabled) return;
    if (visionOn) {
      await visionRef.current?.stop();
      visionRef.current = null;
      setVisionOn(false);
      return;
    }
    const source: VisionSource = window.confirm('Share your SCREEN? (Cancel = use camera)') ? 'screen' : 'camera';
    try {
      const vs = new VisionSender((jpeg) => liveRef.current?.sendVideoFrame(jpeg));
      await vs.start(source);
      visionRef.current = vs;
      setVisionOn(true);
    } catch {
      setVisionOn(false);
    }
  }, [visionEnabled, visionOn]);

  const onHangup = useCallback(() => {
    if (phase === 'ended' || phase === 'error') {
      // reset to idle so the visitor can call again
      endedRef.current = false;
      setPhase('idle');
      setError(null);
      setCaption('');
      return;
    }
    void endCall('user');
  }, [phase, endCall]);

  // ── render ──────────────────────────────────────────────────────────────
  const liveish = phase === 'live' || phase === 'wrapup';
  const remaining = Math.max(0, Math.min(60, limitMin) * 60 - elapsed);
  const billedMin = Math.ceil(elapsed / 60);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6">
      {/* Agent identity */}
      <div className="flex flex-col items-center gap-3 text-center">
        <div
          className={[
            'rounded-full border-zine border-ink bg-lilac p-1.5 shadow-zine',
            agentSpeaking ? 'ring-4 ring-lilac' : '',
          ].join(' ')}
        >
          <Avatar src={avatarUrl} name={name} size={108} fallbackClassName="bg-lilac" />
        </div>
        <h1 className="font-display font-semibold text-[28px] leading-tight text-ink">{name}</h1>
        {role && <p className="max-w-xs font-body font-bold text-[14px] text-inkSoft">{role}</p>}
        {priceText && (
          <span className="inline-flex items-center rounded-full border-zine border-ink bg-card px-3 py-1 font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-ink shadow-zine-xs">
            {priceText}
          </span>
        )}
      </div>

      {/* Body — phase-dependent */}
      {phase === 'idle' && (
        <div className="flex w-full flex-col items-center gap-4">
          <label className="flex w-full max-w-xs flex-col gap-1.5">
            <span className="font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">Talk in</span>
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
          <Button variant="lime" fullWidth label="Talk now" onClick={start} />
          <p className="text-center font-body text-[12px] text-inkMute">
            {free
              ? 'Free to call — the creator covers it. Mic access required.'
              : 'Billed per minute from your AvaWallet. Mic access required.'}
          </p>
        </div>
      )}

      {(phase === 'authing' || phase === 'starting' || phase === 'connecting') && (
        <div className="flex flex-col items-center gap-3 py-4">
          <Spinner size={28} color="var(--zine-lilac)" />
          <span className="font-mono font-bold uppercase text-[12px] tracking-[0.08em] text-inkSoft">
            {phase === 'authing' ? 'verifying…' : phase === 'starting' ? 'starting call…' : 'connecting…'}
          </span>
        </div>
      )}

      {liveish && (
        <div className="flex w-full flex-col items-center gap-4">
          <span
            className={[
              'inline-flex items-center gap-2 rounded-full border-zine border-ink px-3 py-1 shadow-zine-xs',
              'font-mono font-bold uppercase text-[11px] tracking-[0.08em]',
              agentSpeaking ? 'bg-lilac text-ink' : 'bg-card text-inkSoft',
            ].join(' ')}
          >
            {agentSpeaking ? '● speaking' : phase === 'wrapup' ? 'wrapping up' : 'listening'}
          </span>
          {caption && (
            <p className="min-h-[2.5em] max-w-sm text-center font-body font-bold text-[15px] leading-snug text-ink">
              {caption}
            </p>
          )}
          {phase === 'wrapup' && (
            <p className="max-w-xs text-center font-body text-[12px] text-inkMute">
              Time is almost up — the agent will wrap up. Start another call to keep going.
            </p>
          )}
        </div>
      )}

      {(phase === 'ended' || phase === 'error') && (
        <div className="flex w-full flex-col items-center gap-2 rounded-zine border-zine border-ink bg-card p-5 text-center shadow-zine-sm">
          <span className="font-display font-semibold text-[19px] text-ink">
            {phase === 'error' ? 'Could not connect' : 'Call ended'}
          </span>
          {phase === 'error' ? (
            <p className="font-body font-bold text-[14px] text-coral">{error}</p>
          ) : (
            <p className="font-body font-bold text-[14px] text-inkSoft">
              You talked with {name} for {fmtClock(elapsed)}.
              {!free && agent ? ` Billed ~${billedMin} min; unused escrow is refunded.` : ' This call was free.'}
            </p>
          )}
        </div>
      )}

      {/* Controls — visible once a call is in flight or finished */}
      {phase !== 'idle' && phase !== 'authing' && phase !== 'starting' && (
        <CallControls
          phase={phase}
          muted={muted}
          visionEnabled={visionEnabled}
          visionOn={visionOn}
          agentSpeaking={agentSpeaking}
          remainingLabel={`-${fmtClock(remaining)}`}
          alert={phase === 'wrapup'}
          onToggleMute={toggleMute}
          onToggleVision={() => void toggleVision()}
          onHangup={onHangup}
        />
      )}
    </div>
  );
}

/** Exported island — wraps the Clerk/GuestGate host so requireGuestAuth works. */
export default function AgentCall(props: Props) {
  return (
    <ClerkIsland>
      <AgentCallInner {...props} />
    </ClerkIsland>
  );
}
