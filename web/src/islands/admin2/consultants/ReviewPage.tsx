/* ReviewPage — [AUMFE-CONSULT-F4-1] Public "leave a review" page opened from the thank-you message (ReviewMobile mockup).
 * No sign-in: the token in the link is the credential. GET/POST /api/consultants/review/:token.
 * States: loading → ready | invalid | already → submitted. PostHog consult_review_page {state}.
 * Kept free of admin/Clerk imports on purpose (public bundle). */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { ApiError, request } from '../../../lib/apiClient';
import { DISCIPLINE_LABEL, type Discipline } from '../../../lib/consultTypes';
import '../../../styles/consultants.css';

interface ReviewPrompt {
  consultant: { name: string; photo_url: string | null; slug: string };
  discipline: Discipline; slot_start_ms: number; already: boolean;
  /** Optional: the worker may add the customer's first name; the page works without it. */
  customer_first_name?: string | null;
}
const path = (t: string) => `/api/consultants/review/${encodeURIComponent(t)}`;
const MAX = 1000;
type State = 'loading' | 'ready' | 'invalid' | 'already' | 'submitted' | 'error';

const dayLabel = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });

export default function ReviewPage({ token }: { token: string }) {
  const [state, setState] = useState<State>('loading');
  const [info, setInfo] = useState<ReviewPrompt | null>(null);
  const [stars, setStars] = useState(0);
  const [text, setText] = useState('');
  const [firstOnly, setFirstOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const starRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const mark = (s: State) => { setState(s); if (s !== 'loading') capture('consult_review_page', { state: s }); };

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const r = await request<ReviewPrompt>(path(token), { timeoutMs: 15_000 });
        if (off) return;
        setInfo(r); mark(r.already ? 'already' : 'ready');
      } catch (e) {
        if (off) return;
        if (e instanceof ApiError && (e.status === 404 || e.status === 400 || e.status === 410)) mark('invalid');
        else { captureException(e, { where: 'consult_review_page', step: 'load' }); mark('error'); }
      }
    })();
    return () => { off = true; };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const first = info?.customer_first_name?.trim() || null;
  const cname = info?.consultant.name ?? '';
  const cfirst = cname.split(/\s+/)[0] ?? cname;

  const submit = async () => {
    if (stars < 1) { setMsg('Please choose how many stars first.'); starRefs.current[0]?.focus(); return; }
    setBusy(true); setMsg(null);
    try {
      await request(path(token), { method: 'POST', body: { stars, text: text.trim() || undefined, first_name_only: firstOnly }, timeoutMs: 15_000 });
      mark('submitted');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { mark('already'); }
      else if (e instanceof ApiError && (e.status === 404 || e.status === 410)) { mark('invalid'); }
      else { captureException(e, { where: 'consult_review_page', step: 'submit' }); capture('consult_review_page', { state: 'submit_failed' }); setMsg('We could not send your review. Please check your connection and try again.'); }
    } finally { setBusy(false); }
  };

  const onStarKey = (e: KeyboardEvent, i: number) => {
    let n = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') n = Math.min(4, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') n = Math.max(0, i - 1);
    else return;
    e.preventDefault(); setStars(n + 1); starRefs.current[n]?.focus();
  };

  const wrap = (children: ReactNode) => (
    <div className="consult-ui" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div className="ribbon" aria-hidden="true" />
      <div style={{ padding: '28px 16px', display: 'flex', flexDirection: 'column', gap: 18, alignItems: 'center', textAlign: 'center', width: '100%', maxWidth: 480, margin: '0 auto' }}>{children}</div>
    </div>
  );
  const photo = info?.consultant.photo_url
    ? <img className="sticker" src={info.consultant.photo_url} alt={cname} style={{ width: 130, height: 130 }} />
    : null;

  if (state === 'loading') return wrap(<p role="status" className="muted" style={{ fontWeight: 800 }}>Loading…</p>);
  if (state === 'invalid') return wrap(<><h1 style={{ fontSize: 26 }}>This link is not valid</h1><p style={{ fontSize: 17 }}>The review link may be mistyped or too old. Please use the link from your latest message.</p></>);
  if (state === 'error') return wrap(<><h1 style={{ fontSize: 26 }}>Something went wrong</h1><p style={{ fontSize: 17 }}>We could not open this page. Please check your connection.</p><button type="button" className="btn" onClick={() => location.reload()}>Try again</button></>);
  if (state === 'already') return wrap(<>{photo}<h1 style={{ fontSize: 26 }}>You have already reviewed this session</h1><p style={{ fontSize: 17 }}>Thank you. Your review is with our team and will appear on {cfirst} ji's page once it is checked.</p></>);
  if (state === 'submitted') return wrap(<>{photo}<h1 style={{ fontSize: 26 }}>Thank you{first ? `, ${first}` : ''}</h1><p style={{ fontSize: 17 }}>Your review has reached us. Our team will check it before it appears on {cfirst} ji's page.</p></>);

  const disc = info ? DISCIPLINE_LABEL[info.discipline]?.en : '';
  return wrap(<>
    {photo}
    <h1 style={{ fontSize: 26 }}>Thank you{first ? `, ${first}` : ''}</h1>
    <p style={{ fontSize: 17 }}>How was your {disc ? `${disc.toLowerCase()} ` : ''}session with {cname} on {info ? dayLabel(info.slot_start_ms) : ''}?</p>
    <div role="radiogroup" aria-label="Stars" style={{ display: 'flex', gap: 6 }}>
      {[1, 2, 3, 4, 5].map((n, i) => (
        <button key={n} ref={(el) => { starRefs.current[i] = el; }} type="button" role="radio" aria-checked={stars === n} aria-label={`${n} star${n > 1 ? 's' : ''}`}
          tabIndex={stars === n || (stars === 0 && i === 0) ? 0 : -1}
          onClick={() => setStars(n)} onKeyDown={(e) => onStarKey(e, i)}
          style={{ width: 52, height: 52, border: 0, background: 'none', fontSize: 40, lineHeight: 1, color: n <= stars ? '#c48a12' : '#d8cdb1', cursor: 'pointer' }}>★</button>
      ))}
    </div>
    <div className="field" style={{ width: '100%', textAlign: 'left' }}>
      <label htmlFor="rv">Tell others what helped (optional)</label>
      <textarea id="rv" style={{ minHeight: 120 }} value={text} maxLength={MAX} onChange={(e) => setText(e.target.value)} aria-describedby="rv-n" />
      <span className="hint" id="rv-n" style={{ textAlign: 'right' }}>{text.length} / {MAX}</span>
    </div>
    <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 15, width: '100%', textAlign: 'left' }}>
      <input type="checkbox" checked={firstOnly} onChange={(e) => setFirstOnly(e.target.checked)} style={{ width: 22, height: 22 }} />
      Show my first name only{first ? ` (“${first}”)` : ''}
    </label>
    {msg && <div role="alert" style={{ color: '#9a1f19', fontWeight: 800, fontSize: 15 }}>{msg}</div>}
    <button type="button" className="btn" style={{ width: '100%' }} disabled={busy} onClick={() => void submit()}>{busy ? 'Sending…' : 'Send review'}</button>
    <p className="hint">Reviews are checked by our team before they appear on {cfirst} ji's page.</p>
  </>);
}
