/* [AUMFE-CONSULT-F3-1 2026-10-02] /guides/session/:id — the CUSTOMER's audio call screen (SessionCustomer mockup).
 * Waiting room with the consultant's portrait ("Waiting for ..."), connected timer, mute / end / speaker, tarot cards the consultant
 * reveals appear in the card strip, microphone-permission help and the iPhone "keep this tab open" note. Sign-in required.
 * The call engine is lib/consultCall.ts (the customer answers; the consultant is the offerer). Brand name only through BRAND. */
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { IslandBoundary } from '../../components/IslandBoundary';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/env';
import { signInUrlForHere } from '../../lib/authRedirect';
import { captureException, capture } from '../../lib/analytics';
import { BRAND } from '../../lib/brand';
import { DISCIPLINE_LABEL } from '../../lib/consultTypes';
import type { Discipline } from '../../lib/consultTypes';
import { errMessage, errStatus, getMyBooking, SignedOutError } from '../../lib/consultDeskApi';
import type { CustomerBookingLite } from '../../lib/consultDeskApi';
import { Problem, elapsedSeconds, endedText, isLive, joinWindowOpen, statusLine, useConsultCall } from './callUi';
import { HANGUP_SVG, MIC_OFF_SVG, MIC_SVG, SPEAKER_SVG, dayIst, inMinutes, mmss, timeIst, useNow } from './shared';
import { cardNameFallback, cardNumeral } from './tarotDeck';

function useSignedIn(): boolean {
  const { isLoaded, isSignedIn } = useAuth();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { location.replace(signInUrlForHere()); return; }
    setOk(true);
  }, [isLoaded, isSignedIn]);
  return ok;
}
const useGuard: () => boolean = CLERK_PUBLISHABLE_KEY ? useSignedIn : () => true;

const isIos = (): boolean => typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
const discLabel = (d: string): string => DISCIPLINE_LABEL[d as Discipline]?.en ?? d;

function Screen({ b }: { b: CustomerBookingLite }) {
  const now = useNow(1000);
  const { call, s } = useConsultCall({ bookingId: b.id, title: `${BRAND.name} session`, artist: b.consultant.name, artworkUrl: b.consultant.photo_url, role: 'customer' });
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [outs, setOuts] = useState<{ id: string; label: string }[] | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const live = isLive(s);
  const open = joinWindowOpen(b, now);
  const over = now > b.slot_end_ms + 5 * 60_000 || !['confirmed', 'in_call'].includes(b.status);
  const first = b.consultant.name.split(' ')[0];
  const announced = useRef(0);
  const [announce, setAnnounce] = useState('');

  useEffect(() => { capture('consult_call_screen_viewed', { role: 'customer', discipline: b.discipline }); }, [b.discipline]);
  useEffect(() => {
    if (s.reveals.length > announced.current) {
      const r = s.reveals[s.reveals.length - 1];
      announced.current = s.reveals.length;
      setAnnounce(`${first} showed you a card: ${r.position.split('|')[1] ?? cardNameFallback(r.id)}${r.reversed ? ', reversed' : ''}.`);
    }
  }, [s.reveals, first]);
  useEffect(() => { if (!tip) return undefined; const t = setTimeout(() => setTip(null), 4000); return () => clearTimeout(t); }, [tip]);

  const speaker = async () => {
    if (!s.speakerSupported) { setTip('Your phone chooses the speaker by itself. Use the volume buttons, or your phone’s own speaker control.'); return; }
    const list = await call.listOutputs();
    if (!list.length) { setTip('No other speakers were found. Plug in headphones to switch.'); return; }
    setOuts(outs ? null : list);
  };

  const ended = s.status === 'ended';
  const chipText = s.status === 'connected' ? `● Connected · ${mmss(elapsedSeconds(s, now))}` : s.status === 'reconnecting' ? '● Reconnecting…' : live ? '● Waiting room' : ended ? 'Session over' : open ? 'Ready to join' : 'Not open yet';
  const mic = s.error && (s.error.kind === 'mic_denied' || s.error.kind === 'mic_missing');

  return (
    <div className="cs-page">
      <div className="cs-col" style={{ gap: 8 }}>
        <span className="chip" style={{ background: '#f6e7c4', color: '#6b4e12' }} role="status">{chipText}</span>
      </div>
      <div className="cs-col">
        <div className={`cs-ring${live && s.status !== 'connected' ? ' wait' : ''}`} style={{ width: 250, height: 250 }}>
          <img className="sticker" src={b.consultant.photo_url} alt={b.consultant.name} style={{ width: 220, height: 220 }} />
        </div>
        <h1 style={{ fontSize: 26 }}>{b.consultant.name}</h1>
        <p className="muted" style={{ fontSize: 16 }}>
          {ended ? endedText(s.endedReason)
            : s.status === 'connected' ? `Speaking · ${discLabel(b.discipline)}`
              : live ? statusLine(s, first)
                : over ? 'This session is over.'
                  : open ? `${discLabel(b.discipline)} · ${dayIst(b.slot_start_ms)}, ${timeIst(b.slot_start_ms)}`
                    : `Your session starts ${timeIst(b.slot_start_ms)}. The call opens in ${inMinutes(b.join_opens_ms - now)}.`}
        </p>
        {ended ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
            <p style={{ fontSize: 16 }}>Thank you for speaking with {first}.</p>
            <a className="btn" href="/dashboard/consultations">Back to my consultations</a>
          </div>
        ) : null}
        {!live && !ended && !over ? (
          <button type="button" className="btn" disabled={!open} onClick={() => { capture('consult_call_join_clicked', { role: 'customer' }); void call.start(); }} style={{ opacity: open ? 1 : 0.6, minWidth: 220 }}>{s.status === 'error' ? 'Try again' : 'Join the call'}</button>
        ) : null}
        {s.status === 'error' ? <div style={{ width: '100%', textAlign: 'left' }}><Problem s={s} />{mic ? <p className="hint" style={{ marginTop: 6 }}>After you allow the microphone, tap Try again.</p> : null}</div> : null}
        {!live && !ended && !over ? <p className="hint">The call uses your microphone only. Nothing is recorded.</p> : null}
      </div>
      <div className="card" style={{ width: '100%', maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px' }}>
        {s.reveals.length === 0 ? (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div className="tarot" style={{ width: 46, height: 70, fontSize: 13, flexShrink: 0 }}><span className="num">VI</span></div>
            <span style={{ fontSize: 15, fontWeight: 700 }}>Cards shared by your guide appear here (tarot sessions).</span>
          </div>
        ) : (
          <div className="cs-strip" aria-label="Cards your guide showed you">
            {s.reveals.map((r, i) => {
              const [pos, nm] = r.position.split('|');
              const name = nm || cardNameFallback(r.id);
              const n = cardNumeral(r.id);
              return (
                <div key={`${r.at}${i}`} className={`icard${r.reversed ? ' rev' : ''}`} role="img" aria-label={`${pos}: ${name}${r.reversed ? ', reversed' : ''}`}>
                  <span className="pos">{pos}</span><span className="art" /><span className="nm">{n ? `${n} · ` : ''}{name}</span>
                </div>
              );
            })}
          </div>
        )}
        <span aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{announce}</span>
      </div>
      <div className="cs-col" style={{ gap: 14 }}>
        {live ? (
          <div style={{ display: 'flex', gap: 26, alignItems: 'center' }}>
            <button type="button" aria-label={s.muted ? 'Unmute' : 'Mute'} aria-pressed={s.muted} className={`cd-round${s.muted ? ' on' : ''}`} style={{ width: 64, height: 64 }} onClick={() => call.toggleMute()}>{s.muted ? MIC_OFF_SVG : MIC_SVG}</button>
            {confirmEnd ? (
              <div role="alertdialog" aria-label="Leave the call?" style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
                <span style={{ fontWeight: 800, fontSize: 14 }}>Leave the call?</span>
                <div className="cd-row"><button type="button" className="btn small red" onClick={() => { setConfirmEnd(false); call.end(); }}>Leave</button><button type="button" className="btn small ghost" onClick={() => setConfirmEnd(false)}>Stay</button></div>
              </div>
            ) : <button type="button" aria-label="End call" className="cd-round end" style={{ width: 76, height: 76 }} onClick={() => setConfirmEnd(true)}>{HANGUP_SVG}</button>}
            <button type="button" aria-label="Speaker" className="cd-round" style={{ width: 64, height: 64 }} onClick={() => void speaker()}>{SPEAKER_SVG}</button>
          </div>
        ) : null}
        {outs ? (
          <div className="card" role="menu" aria-label="Choose a speaker" style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 4, padding: 8 }}>
            {outs.map((o) => <button key={o.id} type="button" role="menuitem" className="slot" style={{ textAlign: 'left', padding: '0 12px' }} onClick={async () => { await call.setSpeaker(o.id); setOuts(null); }}>{o.label}{s.sinkId === o.id ? ' ✓' : ''}</button>)}
          </div>
        ) : null}
        {tip ? <p className="hint" role="status" style={{ textAlign: 'center' }}>{tip}</p> : null}
        {live && isIos() ? <p className="hint" style={{ textAlign: 'center' }}>Keep this tab open and your screen on. On iPhone, locking the screen or switching apps can pause the call.</p> : null}
        {live && s.status === 'waiting' ? <p className="hint" style={{ textAlign: 'center' }}>{first} will join shortly. You can stay on this screen.</p> : null}
      </div>
    </div>
  );
}

function Boot({ id }: { id: string }) {
  const ok = useGuard();
  const [b, setB] = useState<CustomerBookingLite | null>(null);
  const [err, setErr] = useState<{ gone: boolean; message: string } | null>(null);
  useEffect(() => {
    if (!ok) return;
    let dead = false;
    getMyBooking(id).then((x) => { if (!dead) setB(x); }).catch((e) => {
      if (dead) return;
      if (e instanceof SignedOutError || errStatus(e) === 401) { location.replace(signInUrlForHere()); return; }
      captureException(e, { where: 'consult_session_booking' });
      const st = errStatus(e);
      setErr({ gone: st === 403 || st === 404, message: errMessage(e, 'We could not open this session. Please try again.') });
    });
    return () => { dead = true; };
  }, [ok, id]);
  if (err) {
    return (
      <div className="cs-page"><div className="card" role="alert" style={{ maxWidth: 440, display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'center', background: '#fff' }}>
        <h1 style={{ fontSize: 22 }}>{err.gone ? 'This session is not on your account' : 'Something went wrong'}</h1>
        <p className="muted">{err.gone ? 'Sign in with the account you used to book it.' : err.message}</p>
        <a className="btn" href="/dashboard/consultations">My consultations</a>
      </div><span /></div>
    );
  }
  if (!ok || !b) return <div className="cs-page" aria-busy="true"><span /><p className="muted">Opening your session…</p><span /></div>;
  return <Screen b={b} />;
}

export default function SessionApp({ bookingId }: { bookingId: string }) {
  return (
    <IslandBoundary island="consult_session">
      <ClerkIsland><Boot id={bookingId} /></ClerkIsland>
    </IslandBoundary>
  );
}
