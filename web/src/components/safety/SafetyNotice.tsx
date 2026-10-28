/* [HF-CALL-SAFETY-WEB] The safety notice a fan sees before every web Call / Book / Join-queue action (artboard AppFanNotice).
 * Shown only while hfCallRecordingEnabled is on, and until the fan ticks "Don't show this again" (stored per account in this browser).
 * Nothing new is spoken on the call: this notice is the only place the rules are shown.
 *
 *   const notice = useSafetyNotice();
 *   if (!(await notice.ask({ name: 'Riya', cta: 'OK, call now · ₹12/min', surface: 'call' }))) return;   // true = go ahead
 *   …render {notice.node} once in the component. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BRAND } from '../../lib/brand';
import { capture } from '../../lib/analytics';
import { SAFETY_EVENTS, dismissNoticeForever, noticeDismissed, recordingEnabled } from '../../lib/hfSafetyApi';
import { Marigold, Jasmine } from '../../islands/dashboard-hf/v3/ui';
import '../../styles/hf-safety.css';

export interface NoticeAsk {
  /** First name of the influencer. */
  name: string;
  /** Button text, e.g. "OK, call now · ₹12/min". */
  cta: string;
  /** Start of the eyebrow, default "Before you call". */
  verb?: string;
  surface: 'call' | 'book' | 'queue';
}

const Svg = ({ children, stroke }: { children: ReactNode; stroke: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

function Mogra() {
  return <div className="hsf-mogra" aria-hidden="true">{Array.from({ length: 11 }, (_, i) => i % 4 === 3 ? <Marigold key={i} size={18} tone={1} /> : <Jasmine key={i} size={18} />)}</div>;
}

export function SafetyNoticeDialog({ ask, onYes, onNo }: { ask: NoticeAsk; onYes: (dontShowAgain: boolean) => void; onNo: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [again, setAgain] = useState(false);
  const decided = useRef(false);
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (!d.open) { try { d.showModal(); } catch { d.setAttribute('open', ''); } }
    capture(SAFETY_EVENTS.noticeShown, { surface: ask.surface });
  }, [ask.surface]);
  const yes = () => { decided.current = true; onYes(again); };
  return (
    <dialog ref={ref} className="hsf-dlg" aria-labelledby="hsf-n-t" onClose={() => { if (!decided.current) { decided.current = true; onNo(); } }}>
      <section className="hsf-sheet">
        <Mogra />
        <span className="fl" aria-hidden="true"><Marigold size={70} /></span>
        <div className="hsf-kick" style={{ marginTop: 4 }}>{ask.verb ?? 'Before you call'} {ask.name}</div>
        <h2 id="hsf-n-t">Keep your call safe</h2>
        <div className="hsf-list">
          <div className="hsf-li"><span className="hsf-ico" style={{ background: '#F1EBFF' }}><Svg stroke="#6D4FD0"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></Svg></span>Calls are recorded for safety. Nobody listens live.</div>
          <div className="hsf-li"><span className="hsf-ico" style={{ background: '#E3F6F6' }}><Svg stroke="#0E7C86"><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M4 4l16 16" /></Svg></span>Don’t share your phone number, UPI ID or address.</div>
          <div className="hsf-li"><span className="hsf-ico" style={{ background: '#FFF1D6' }}><Svg stroke="#B45309"><path d="M7 5h10M7 9h10M9 5c4 0 4 8 0 8H7l7 7" /></Svg></span>Never pay outside {BRAND.name}. If someone asks, report it after the call.</div>
        </div>
        <button type="button" className="hsf-btn wide" style={{ marginTop: 4 }} onClick={yes}>{ask.cta}</button>
        <label className="hsf-check center"><input type="checkbox" checked={again} onChange={e => setAgain(e.target.checked)} /><span className="bx" aria-hidden="true">{again ? '✓' : ''}</span>Don’t show this again</label>
        <button type="button" className="hsf-btn ghost" onClick={() => ref.current?.close()}>Not now</button>
      </section>
    </dialog>
  );
}

export function useSafetyNotice(): { ask: (a: NoticeAsk) => Promise<boolean>; node: ReactNode } {
  const [open, setOpen] = useState<{ a: NoticeAsk; done: (ok: boolean) => void } | null>(null);
  const pending = useRef<((ok: boolean) => void) | null>(null);
  const ask = useCallback(async (a: NoticeAsk): Promise<boolean> => {
    // Flag off, or the lookup failed, or the fan already said "don't show again": go straight through.
    const on = await recordingEnabled();
    if (!on || noticeDismissed()) return true;
    pending.current?.(false); // a second ask replaces an unanswered one
    return new Promise<boolean>(resolve => { pending.current = resolve; setOpen({ a, done: resolve }); });
  }, []);
  const node = open ? (
    <SafetyNoticeDialog key={open.a.surface + open.a.name} ask={open.a}
      onYes={again => { if (again) dismissNoticeForever(); capture(SAFETY_EVENTS.noticeOk, { surface: open.a.surface, dont_show_again: again }); open.done(true); setOpen(null); }}
      onNo={() => { capture(SAFETY_EVENTS.noticeCancel, { surface: open.a.surface }); open.done(false); setOpen(null); }} />
  ) : null;
  return { ask, node };
}
