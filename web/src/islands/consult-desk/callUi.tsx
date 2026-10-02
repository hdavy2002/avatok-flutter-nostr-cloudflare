/* [AUMFE-CONSULT-F3-1 2026-10-02] Call UI for the CONSULTANT side (the engine is lib/consultCall.ts):
 *   CallPanel  -> desktop right column (FileAstroDesktop mockup): timer chip, avatar, mute, end, private notes
 *   CallBar    -> phone sticky bottom bar (FilePalmMobile mockup) that stays while the page scrolls and expands to a bigger panel
 * Join is enabled from the booking rules (confirmed/in_call, from join_opens_ms until slot end + 5 min); the server re-checks. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { ConsultCall } from '../../lib/consultCall';
import type { CallState } from '../../lib/consultCall';
import { postCallTicket } from '../../lib/consultDeskApi';
import { HANGUP_SVG, MIC_OFF_SVG, MIC_SVG, initials, inMinutes, mmss, timeIst, useNow } from './shared';

export const GRACE_AFTER_MS = 5 * 60_000;

export function joinWindowOpen(b: { status: string; join_opens_ms: number; slot_end_ms: number }, now: number): boolean {
  return (b.status === 'confirmed' || b.status === 'in_call') && now >= b.join_opens_ms && now <= b.slot_end_ms + GRACE_AFTER_MS;
}

export function useConsultCall(opts: { bookingId: string; title: string; artist: string; artworkUrl?: string; role: 'customer' | 'consultant' }): { call: ConsultCall; s: CallState } {
  const ref = useRef<ConsultCall | null>(null);
  if (!ref.current) {
    ref.current = new ConsultCall({
      fetchTicket: () => postCallTicket(opts.bookingId), title: opts.title, artist: opts.artist, artworkUrl: opts.artworkUrl, role: opts.role,
    });
  }
  const call = ref.current;
  const s = useSyncExternalStore(call.subscribe, call.getState, call.getState);
  useEffect(() => {
    const bye = () => call.destroy();
    window.addEventListener('pagehide', bye);
    return () => { window.removeEventListener('pagehide', bye); call.destroy(); };
  }, [call]);
  return { call, s };
}

export function isLive(s: CallState): boolean { return s.status === 'starting' || s.status === 'connecting' || s.status === 'waiting' || s.status === 'connected' || s.status === 'reconnecting'; }

export function elapsedSeconds(s: CallState, now: number): number { return s.startedAt ? Math.max(0, (now - s.startedAt) / 1000) : 0; }

export function endedText(r: CallState['endedReason']): string {
  switch (r) {
    case 'ended_by_consultant': return 'The session was ended.';
    case 'slot_over': return 'The session time is over.';
    case 'admin': return 'The session was ended by the team.';
    case 'left': return 'You left the call.';
    default: return 'The call ended.';
  }
}

export function problemCopy(s: CallState): { title: string; body: string } | null {
  const e = s.error;
  if (!e) return null;
  switch (e.kind) {
    case 'mic_denied': return { title: 'We could not use your microphone', body: 'To talk, your browser needs permission to use the microphone. Tap the lock or settings icon next to the web address, switch Microphone to Allow, then try again.' };
    case 'mic_missing': return { title: 'No microphone found', body: 'We could not find a microphone on this device. Plug one in or check your headphones, then try again.' };
    case 'mic_unsupported': return { title: 'This browser cannot do audio calls', body: 'Please open this page in the latest Chrome, Safari or Edge and try again.' };
    case 'mic_failed': return { title: 'The microphone did not start', body: 'Close other apps that may be using the microphone, then try again.' };
    case 'ticket':
      if (e.status === 401) return { title: 'Please sign in again', body: 'Your sign-in has expired. Reload this page and sign in.' };
      if (e.status === 403) return { title: 'This session is not on your account', body: 'Only the person who booked it and the consultant can join.' };
      if (e.status === 409 || e.status === 425 || e.status === 400) return { title: 'The call is not open yet', body: 'You can join 10 minutes before the start time, once the booking is confirmed.' };
      return { title: 'We could not open the call', body: 'Please check your connection and try again.' };
    case 'socket': return { title: 'The connection was lost', body: 'We could not restore it. Tap Join to connect again.' };
    default: return { title: 'Something went wrong with the call', body: 'Please try joining again.' };
  }
}

export function Problem({ s }: { s: CallState }) {
  const p = problemCopy(s);
  if (!p) return null;
  return <div className="card" role="alert" style={{ background: '#fbe1dc', borderColor: '#f0b8ae', padding: 12 }}><strong>{p.title}</strong><p style={{ fontSize: 15, marginTop: 4 }}>{p.body}</p></div>;
}

export function statusLine(s: CallState, other: string): string {
  switch (s.status) {
    case 'starting': return 'Starting…';
    case 'connecting': return 'Connecting…';
    case 'waiting': return `Waiting for ${other} to join…`;
    case 'reconnecting': return 'Connection dropped, reconnecting…';
    case 'connected': return 'Connected';
    case 'ended': return endedText(s.endedReason);
    case 'error': return 'Could not connect';
    default: return '';
  }
}

interface PanelProps {
  s: CallState; name: string; slotMinutes: number; canJoin: boolean; joinNote: string; opensInMs: number;
  onJoin: () => void; onMute: () => void; onEnd: () => void; notes?: ReactNode;
}

function EndButton({ onEnd, size, initialAsk = false }: { onEnd: () => void; size: number; initialAsk?: boolean }) {
  const [ask, setAsk] = useState(initialAsk);
  if (!ask) return <button type="button" className="cd-round end" aria-label="End call" style={{ width: size, height: size }} onClick={() => setAsk(true)}>{HANGUP_SVG}</button>;
  return (
    <div role="alertdialog" aria-label="End the session for both of you?" style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
      <span style={{ fontSize: 14, fontWeight: 800 }}>End for both of you?</span>
      <div className="cd-row"><button type="button" className="btn small red" onClick={() => { setAsk(false); onEnd(); }}>End session</button><button type="button" className="btn small ghost" onClick={() => setAsk(false)}>Keep going</button></div>
    </div>
  );
}

function Controls({ s, onMute, onEnd, size = 60, initialAsk = false }: { s: CallState; onMute: () => void; onEnd: () => void; size?: number; initialAsk?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 16, justifyContent: 'center', alignItems: 'center' }}>
      <button type="button" className={`cd-round${s.muted ? ' on' : ''}`} aria-label={s.muted ? 'Unmute' : 'Mute'} aria-pressed={s.muted} style={{ width: size, height: size }} onClick={onMute}>{s.muted ? MIC_OFF_SVG : MIC_SVG}</button>
      <EndButton onEnd={onEnd} size={size} initialAsk={initialAsk} />
    </div>
  );
}

function JoinButton({ canJoin, onJoin, label = 'Join call' }: { canJoin: boolean; onJoin: () => void; label?: string }) {
  return <button type="button" className="btn" disabled={!canJoin} onClick={onJoin} style={{ opacity: canJoin ? 1 : 0.6 }}>{label}</button>;
}

/* desktop right column */
export function CallPanel(p: PanelProps) {
  const now = useNow(1000);
  const live = isLive(p.s);
  const total = p.slotMinutes * 60;
  return (
    <>
      <span className="chip" style={{ background: '#f6e7c4', color: '#6b4e12', alignSelf: 'flex-start' }} role="status">
        {p.s.status === 'connected' ? `● Connected · ${mmss(elapsedSeconds(p.s, now))} of ${mmss(total)}` : p.s.status === 'reconnecting' ? '● Reconnecting…' : live ? '● Waiting' : p.s.status === 'ended' ? 'Session over' : p.canJoin ? 'Ready to join' : 'Not started'}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' }}>
        <div className="cd-av" style={{ width: 150, height: 150, fontSize: 48 }} aria-hidden="true">{initials(p.name)}</div>
        <strong style={{ fontSize: 20, marginTop: 6 }}>{p.name}</strong>
        <span className="muted" style={{ fontSize: 15 }}>{live || p.s.status === 'ended' ? statusLine(p.s, p.name) : p.canJoin ? 'Tap Join when you are ready.' : p.joinNote}</span>
      </div>
      <Problem s={p.s} />
      {live ? <Controls s={p.s} onMute={p.onMute} onEnd={p.onEnd} /> : p.s.status === 'ended' ? null : <JoinButton canJoin={p.canJoin} onJoin={p.onJoin} label={p.s.status === 'error' ? 'Try again' : 'Join call'} />}
      {p.notes}
    </>
  );
}

/* phone sticky bar + expandable sheet */
export function CallBar(p: PanelProps & { theme?: string; startsAt: number }) {
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const [endAsk, setEndAsk] = useState(false);
  const live = isLive(p.s);
  const total = p.slotMinutes * 60;
  const bg = p.theme ?? undefined;
  const sub = p.s.status === 'connected' ? `● ${mmss(elapsedSeconds(p.s, now))} of ${mmss(total)} · call stays on while you scroll`
    : live ? statusLine(p.s, p.name)
      : p.s.status === 'ended' ? endedText(p.s.endedReason)
        : p.canJoin ? 'Join is open' : `Join opens in ${inMinutes(p.opensInMs)}`;
  return (
    <div className="cd-callwrap cd-mobile-only">
      {open ? (
        <div className="cd-sheet" role="dialog" aria-label="Call panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="chip" style={{ background: '#f6e7c4', color: '#6b4e12' }}>{sub.split(' · ')[0]}</span>
            <button type="button" className="edit" onClick={() => { setOpen(false); setEndAsk(false); }}>Close</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, textAlign: 'center' }}>
            <div className="cd-av" style={{ width: 110, height: 110, fontSize: 36 }} aria-hidden="true">{initials(p.name)}</div>
            <strong style={{ fontSize: 20 }}>{p.name}</strong>
            <span className="muted" style={{ fontSize: 15 }}>{statusLine(p.s, p.name) || sub}</span>
          </div>
          <Problem s={p.s} />
          {live ? <Controls s={p.s} onMute={p.onMute} onEnd={p.onEnd} initialAsk={endAsk} /> : p.s.status === 'ended' ? null : <JoinButton canJoin={p.canJoin} onJoin={p.onJoin} />}
          {p.notes}
        </div>
      ) : null}
      {!live && p.s.status === 'error' && !open ? <div style={{ marginBottom: 8 }}><Problem s={p.s} /></div> : null}
      <div className="callbar" style={bg ? { background: bg } : undefined}>
        <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#fff', color: '#07545b', fontFamily: "'Comfortaa', sans-serif", fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }} aria-hidden="true">{initials(p.name)}</div>
        <button type="button" className="txt" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${p.name}, ${sub}. ${open ? 'Collapse' : 'Expand'} call panel`}>
          <strong style={{ fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{live || p.s.status === 'ended' ? p.name : `Session starts ${timeIst(p.startsAt)}`}</strong>
          <span style={{ fontSize: 14, color: '#d7dcf0' }}>{sub}</span>
        </button>
        {live ? (
          <>
            <button type="button" className="round" aria-label={p.s.muted ? 'Unmute' : 'Mute'} aria-pressed={p.s.muted} onClick={p.onMute}>{p.s.muted ? MIC_OFF_SVG : MIC_SVG}</button>
            <button type="button" className="round end" aria-label="End call" onClick={() => { setEndAsk(true); setOpen(true); }}>{HANGUP_SVG}</button>
          </>
        ) : p.s.status === 'ended' ? null : (
          <button type="button" className="btn small" style={{ background: '#fff', color: '#07545b', opacity: p.canJoin ? 1 : 0.7 }} disabled={!p.canJoin} onClick={p.onJoin}>{p.s.status === 'error' ? 'Retry' : 'Join'}</button>
        )}
      </div>
    </div>
  );
}
