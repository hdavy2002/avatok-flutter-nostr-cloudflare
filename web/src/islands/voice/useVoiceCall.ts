/* [AUMFE-VOICE-WEB-1] Call state machine for the voice screen: owns the VoiceClient, turns server messages
 * into React state and fires the telemetry (voice_call_started / voice_call_ended / voice_mic_denied /
 * voice_first_audio_ms) through lib/analytics. The click handler that calls start() is the user gesture the
 * browser needs for the mic and for audio playback, so start() asks for both before any network work. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { capture, captureException } from '../../lib/analytics';
import { errCode, errMessage, errStatus, getTicket, SignedOutError } from './api';
import { MicError, VoiceClient } from './voiceClient';
import type { AgentState, ServerMsg, VoiceAgentPublic, VoiceCard } from './types';

export type CallPhase = 'idle' | 'connecting' | 'live' | 'ended';

export interface Caption { id: number; who: 'user' | 'agent'; text: string; final: boolean }
export interface Meter { seconds: number; costPaise: number; remainingSeconds: number }
export interface ReadyInfo {
  sessionId: string; remembers: string[]; maxSeconds: number; freeSeconds: number; pricePerMinPaise: number; billing: 'test' | 'live';
}
export interface CallSummary {
  seconds: number; costPaise: number; billing: 'test' | 'live'; reason: string; sessionId: string | null; remembers: string[];
}
export interface CallError {
  kind: 'mic_denied' | 'mic_missing' | 'mic_unsupported' | 'mic_failed' | 'server' | 'closed' | 'insufficient_balance'; message: string;
  /* [AUMFE-VOICE-BILLING-1] only for insufficient_balance: wallet tokens (1 token = Rs 1), the minute price, and who she is. */
  balanceTokens?: number; priceTokens?: number; agentName?: string;
}

const MAX_CAPTIONS = 40;

function micErrorToCallError(e: MicError): CallError {
  switch (e.kind) {
    case 'denied': return { kind: 'mic_denied', message: '' };
    case 'no_device': return { kind: 'mic_missing', message: '' };
    case 'unsupported': return { kind: 'mic_unsupported', message: '' };
    default: return { kind: 'mic_failed', message: '' };
  }
}

export function useVoiceCall() {
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [agent, setAgent] = useState<VoiceAgentPublic | null>(null);
  const [ready, setReady] = useState<ReadyInfo | null>(null);
  const [agentState, setAgentState] = useState<AgentState>('connecting');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [cards, setCards] = useState<VoiceCard[]>([]);
  const [toolBusy, setToolBusy] = useState<string | null>(null);
  const [meter, setMeter] = useState<Meter | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [endingSoon, setEndingSoon] = useState<number | null>(null);
  const [muted, setMutedState] = useState(false);
  const [error, setError] = useState<CallError | null>(null);
  const [summary, setSummary] = useState<CallSummary | null>(null);
  const [ending, setEnding] = useState(false);

  const clientRef = useRef<VoiceClient | null>(null);
  const agentRef = useRef<VoiceAgentPublic | null>(null);
  const readyRef = useRef<ReadyInfo | null>(null);
  const meterRef = useRef<Meter | null>(null);
  const elapsedRef = useRef(0);
  const doneRef = useRef(true);
  const captionId = useRef(0);
  const endTimer = useRef<number | null>(null);

  const finalize = useCallback((reason: string, sessionId?: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (endTimer.current !== null) { window.clearTimeout(endTimer.current); endTimer.current = null; }
    const c = clientRef.current;
    clientRef.current = null;
    c?.close();
    const r = readyRef.current;
    const seconds = Math.max(meterRef.current?.seconds ?? 0, 0) || elapsedRef.current;
    // [AUMFE-VOICE-FIX-1] A call that failed in its first seconds is a connection failure, not a finished talk.
    if (!r || (reason === 'error' && seconds < 5)) {
      if (r) capture('voice_call_ended', { agent: agentRef.current?.id ?? '', seconds, reason });
      // never got going: back to where they were, with a calm message
      setPhase('idle');
      setError((prev) => prev ?? { kind: 'closed', message: '' });
      return;
    }
    capture('voice_call_ended', { agent: agentRef.current?.id ?? '', seconds, reason });
    setSummary({
      seconds, costPaise: meterRef.current?.costPaise ?? 0, billing: r.billing, reason,
      sessionId: sessionId ?? r.sessionId, remembers: r.remembers,
    });
    setPhase('ended');
  }, []);

  const onMessage = useCallback((m: ServerMsg) => {
    switch (m.type) {
      case 'ready': {
        const info: ReadyInfo = {
          sessionId: m.session_id, remembers: m.remembers ?? [], maxSeconds: m.max_seconds, freeSeconds: m.free_seconds,
          pricePerMinPaise: m.price_per_min_paise, billing: m.billing,
        };
        readyRef.current = info;
        setReady(info);
        setAgent(m.agent);
        agentRef.current = m.agent;
        setPhase('live');
        capture('voice_call_started', { agent: m.agent.id });
        break;
      }
      case 'agent_state': setAgentState(m.state); break;
      case 'caption':
        setCaptions((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.who === m.who && !last.final) {
            const next = prev.slice(0, -1);
            next.push({ ...last, text: m.text, final: m.final });
            return next;
          }
          if (!m.text.trim()) return prev;
          captionId.current += 1;
          return [...prev, { id: captionId.current, who: m.who, text: m.text, final: m.final }].slice(-MAX_CAPTIONS);
        });
        break;
      case 'tool':
        if (m.status === 'start') setToolBusy(m.name);
        else {
          setToolBusy(null);
          if (m.status === 'done' && m.card) {
            const card = m.card;
            setCards((prev) => [...prev, card].slice(-4));
          }
        }
        break;
      case 'meter': {
        const mt = { seconds: m.seconds, costPaise: m.cost_paise, remainingSeconds: m.remaining_seconds };
        meterRef.current = mt;
        setMeter(mt);
        break;
      }
      case 'ending_soon': setEndingSoon(m.remaining_seconds); break;
      case 'ended': finalize(m.reason, m.session_id); break;
      case 'error':
        if (m.code === 'insufficient_balance') {
          // the wallet dropped below one minute between the ticket and the start of the call
          const price = readyRef.current?.pricePerMinPaise;
          setError({ kind: 'insufficient_balance', message: m.message, agentName: agentRef.current?.name, priceTokens: price ? Math.ceil(price / 100) : undefined });
        } else setError({ kind: 'server', message: m.message });
        if (!readyRef.current) finalize('error');
        break;
      case 'interrupted': break; // the client already flushed playback
    }
  }, [finalize]);

  /** Starts a call. `pre` runs after the mic is granted and before the ticket (e.g. saving birth details). */
  const start = useCallback(async (a: VoiceAgentPublic, pre?: () => Promise<void>): Promise<boolean> => {
    if (clientRef.current) return false;
    doneRef.current = false;
    setError(null); setSummary(null); setReady(null); setMeter(null); setCaptions([]); setCards([]);
    setToolBusy(null); setEndingSoon(null); setMutedState(false); setEnding(false); setElapsed(0); setAgentState('connecting');
    readyRef.current = null; meterRef.current = null; elapsedRef.current = 0;
    agentRef.current = a;
    setAgent(a);
    setPhase('connecting');
    capture('voice_call_screen_opened', { agent: a.id });

    const client = new VoiceClient({
      onMessage,
      onClose: () => finalize('server'),
      onFirstAudio: (ms) => capture('voice_first_audio_ms', { agent: agentRef.current?.id ?? '', ms }),
    });
    clientRef.current = client;
    const fail = (e: CallError) => {
      doneRef.current = true;
      clientRef.current = null;
      client.close();
      setError(e);
      setPhase('idle');
      return false;
    };
    try {
      await client.prepareAudio(); // mic prompt + audio contexts, straight from the click
    } catch (e) {
      if (e instanceof MicError) {
        if (e.kind === 'denied') capture('voice_mic_denied', { agent: a.id });
        return fail(micErrorToCallError(e));
      }
      captureException(e, { where: 'voice_prepare_audio' });
      return fail({ kind: 'mic_failed', message: '' });
    }
    try {
      if (pre) await pre();
    } catch (e) {
      if (e instanceof SignedOutError) return fail({ kind: 'server', message: e.message });
      return fail({ kind: 'server', message: errMessage(e, 'We could not save your details. Please check them and try again.') });
    }
    try {
      const t = await getTicket(a.id);
      if (doneRef.current) return false;
      client.connect(t.ws_url);
      return true;
    } catch (e) {
      const status = errStatus(e);
      const code = errCode(e);
      if (status === 402 && code === 'insufficient_balance') {
        const body = (e as { body?: { balance_tokens?: unknown; price_per_min_tokens?: unknown } }).body ?? {};
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
        capture('voice_call_blocked_balance', { agent: a.id, balance_tokens: num(body.balance_tokens) ?? -1 });
        return fail({ kind: 'insufficient_balance', message: '', balanceTokens: num(body.balance_tokens), priceTokens: num(body.price_per_min_tokens), agentName: a.name });
      }
      const msg = status === 403 || code === 'voice_disabled' || code === 'forbidden'
        ? 'This guide is not open to you yet. We will let you know when she is ready.'
        : errMessage(e, 'We could not start the call. Please try again in a moment.');
      return fail({ kind: 'server', message: msg });
    }
  }, [finalize, onMessage]);

  const toggleMute = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    const next = !c.muted;
    c.setMuted(next);
    setMutedState(next);
  }, []);

  const end = useCallback(() => {
    const c = clientRef.current;
    if (!c || doneRef.current) return;
    setEnding(true);
    c.end();
    // the server answers with "ended"; if it does not, close ourselves
    endTimer.current = window.setTimeout(() => finalize('customer'), 2500);
  }, [finalize]);

  const reset = useCallback(() => {
    setPhase('idle'); setSummary(null); setError(null); setReady(null);
  }, []);

  // local clock fallback (the server's meter wins whenever it has spoken)
  useEffect(() => {
    if (phase !== 'live') return undefined;
    const t0 = Date.now();
    const id = window.setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      elapsedRef.current = s;
      setElapsed(s);
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  // leaving the page closes the call
  useEffect(() => {
    const bye = () => { clientRef.current?.end(); clientRef.current?.close(); };
    window.addEventListener('pagehide', bye);
    return () => {
      window.removeEventListener('pagehide', bye);
      if (endTimer.current !== null) window.clearTimeout(endTimer.current);
      doneRef.current = true;
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  return {
    phase, agent, ready, agentState, captions, cards, toolBusy, meter, elapsed, endingSoon, muted, error, summary, ending,
    clientRef, start, toggleMute, end, reset,
  };
}

export type VoiceCall = ReturnType<typeof useVoiceCall>;
