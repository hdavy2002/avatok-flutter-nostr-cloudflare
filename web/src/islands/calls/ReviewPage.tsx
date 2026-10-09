/* [HF-CALLS-1] /review/<token>: rate a finished call, no sign-in (the token came by WhatsApp). */
import { useEffect, useState } from 'react';
import ReviewForm from './ReviewForm';
import { hfCall, relDate } from '../../lib/hfCallsApi';
import '../../styles/hf-calls.css';

interface Info { hostName: string; hostSlug: string; callDate: number | string | null; minutes: number | null; alreadyReviewed: boolean }

export default function ReviewPage({ token }: { token: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'gone' | 'error'>('loading');
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    void hfCall<Info>('GET', `/api/hf/review/${encodeURIComponent(token)}`, undefined, { auth: false }).then(r => {
      if (!live) return;
      if (r.ok) { setInfo(r.data); setState('ok'); }
      else setState(r.status === 404 || r.status === 410 ? 'gone' : 'error');
    });
    return () => { live = false; };
  }, [token]);

  const name = (info?.hostName || '').split(/\s+/)[0] || 'your host';
  return (
    <main className="hfc-page">
      {state === 'loading' && <p role="status">Loading…</p>}
      {state === 'gone' && <><h1>This link has expired</h1><p>Review links work for 7 days after a call. You can still visit the host’s page to see how others found their calls.</p><a className="hfc-btn hfc-primary" href="/marketplace">Explore hosts</a></>}
      {state === 'error' && <><h1>Something went wrong</h1><p>We could not open this page. Please check your internet and try again.</p><button type="button" className="hfc-btn hfc-primary" onClick={() => window.location.reload()}>Try again</button></>}
      {state === 'ok' && info && (
        <>
          <h1>Rate your call with {name}</h1>
          <p>{info.callDate ? `${relDate(info.callDate)}` : ''}{info.minutes ? ` · ${info.minutes} min` : ''}</p>
          <div className="hfc-card">
            {info.alreadyReviewed
              ? <p className="hfc-note hfc-ok" role="status">You’ve already reviewed this call. Thank you!</p>
              : <ReviewForm mode="token" token={token} hostName={name} onDone={() => setDone(true)} />}
          </div>
          {(done || info.alreadyReviewed) && info.hostSlug && <a className="hfc-btn" href={`/h/${info.hostSlug}`}>See {name}’s page</a>}
          <p className="hfc-sub" style={{ color: '#785979' }}>Reviews are checked by our team before they show. Your full name is never shown.</p>
        </>
      )}
    </main>
  );
}
