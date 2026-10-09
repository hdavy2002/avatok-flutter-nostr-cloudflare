/* [HF-CALLS-1] Star rating + short text + optional topic. Used on /review/<token> (no sign-in) and inside the call summary (signed in). */
import { useState } from 'react';
import { moods } from '../../lib/callvaalHomeReference';
import { hfCall } from '../../lib/hfCallsApi';

const WORDS = ['', 'Not good', 'Could be better', 'Okay', 'Good', 'Really good'];

export default function ReviewForm({ mode, token, callId, hostName, onDone }: {
  mode: 'token' | 'call'; token?: string; callId?: string; hostName: string; onDone?: () => void;
}) {
  const [stars, setStars] = useState(0);
  const [text, setText] = useState('');
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (stars < 1) { setErr('Please tap a star first.'); return; }
    setBusy(true); setErr('');
    const body = { stars, text: text.trim(), topic: topic || undefined };
    const r = mode === 'token'
      ? await hfCall<{ ok: boolean }>('POST', `/api/hf/review/${encodeURIComponent(token ?? '')}`, body, { auth: false })
      : await hfCall<{ ok: boolean }>('POST', `/api/hf/calls/${encodeURIComponent(callId ?? '')}/review`, body);
    setBusy(false);
    if (r.ok) { setSent(true); onDone?.(); return; }
    if (r.code === 'contact_details') setErr('Please remove phone numbers, emails or links from your review. We keep contact details private.');
    else if (r.status === 401) setErr('Please sign in again to leave your review.');
    else setErr(r.message || 'We could not save your review. Please try again.');
  };

  if (sent) {
    return <div className="hfc-note hfc-ok" role="status"><strong>Thank you!</strong> Your review will show on {hostName}’s page once our team has checked it.</div>;
  }
  return (
    <form className="hfc-review" onSubmit={submit} noValidate>
      <fieldset className="hfc-field">
        <legend>How was your call with {hostName}?</legend>
        <div role="radiogroup" aria-label="Star rating" className="hfc-star-row">
          {[1, 2, 3, 4, 5].map(n => (
            <button key={n} type="button" role="radio" aria-checked={stars === n} aria-label={`${n} star${n > 1 ? 's' : ''}`}
              className={`hfc-star${n <= stars ? ' on' : ''}`} onClick={() => setStars(n)}>★</button>
          ))}
        </div>
        <span className="hfc-star-word" aria-live="polite">{WORDS[stars]}</span>
      </fieldset>
      <label className="hfc-label" htmlFor="hfc-review-text">Anything you’d like to say? (optional)</label>
      <textarea id="hfc-review-text" className="hfc-input" rows={4} maxLength={500} value={text} onChange={e => setText(e.target.value)}
        placeholder="What was it like to talk to them?" />
      <small className="hfc-count">{text.length}/500 · Please don’t share phone numbers or links.</small>
      <label className="hfc-label" htmlFor="hfc-review-topic">What did you talk about? (optional)</label>
      <select id="hfc-review-topic" className="hfc-input" value={topic} onChange={e => setTopic(e.target.value)}>
        <option value="">Pick a topic</option>
        {moods.map(m => <option key={m.slug} value={m.slug}>{m.label}</option>)}
      </select>
      {err && <p className="hfc-err" role="alert">{err}</p>}
      <button type="submit" className="hfc-btn hfc-primary" disabled={busy}>{busy ? 'Sending…' : 'Send review'}</button>
    </form>
  );
}
