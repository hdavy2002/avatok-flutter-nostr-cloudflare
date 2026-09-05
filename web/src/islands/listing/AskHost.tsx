// [LIST-ASK-1] "Ask the host" — a small form under MEET THE HOST. One question
// per listing (worker enforces UNIQUE(listing_id, asker_id) -> 409), 5/day rate
// limit (-> 429), and the server strips phone numbers/links from the text
// regardless (`maskContact` in worker/src/routes/listing_questions.ts) — a 400
// there means the raw text was rejected outright (empty/too long/own listing).
//
// Guests: askListingQuestion needs a real session (requireUser), so an
// anonymous visitor gets a sign-in link instead of a form — no inline
// email/OTP flow here, that lives in the booking flow where it's unavoidable.
import { useEffect, useState } from 'react';
// [ASK-HOST-AUTH-1 2026-09-05] getActiveTokenWaited, not getActiveToken.
//
// This island decided "signed in or not" from a SINGLE immediate read on
// mount, and lost a race it could not win: `getActiveToken()` returns whatever
// is available right now, and the module-level Clerk bridge is populated by
// ClerkBridge's own effect a beat later. Mount first, read null, fall through
// to the stored guest token (which a Clerk-only visitor does not have) — and
// render the sign-in card permanently, to somebody who is signed in.
//
// `getActiveTokenWaited` exists for exactly this and says so in its doc
// comment. Every dashboard island already imports it under this alias; this one
// was simply missed, which is why the bug only showed on the public listing
// page.
import { ClerkIsland, getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { askListingQuestion, ApiError } from '../../lib/apiClient';
import { capture } from '../../lib/analytics';
import { askHost } from '../../lib/copy';

export interface AskHostProps {
  listingId: string;
  hostName: string;
}

type Status = 'idle' | 'submitting' | 'success' | 'already' | 'rate_limited' | 'masked' | 'error';

function AskHostInner({ listingId, hostName }: AskHostProps) {
  const [token, setToken] = useState<string | null | undefined>(undefined); // undefined = still checking
  const [question, setQuestion] = useState('');
  const [status, setStatus] = useState<Status>('idle');

  useEffect(() => {
    let alive = true;
    getActiveToken().then((t) => {
      if (alive) setToken(t);
    });
    return () => {
      alive = false;
    };
  }, []);

  const hostFirstName = hostName.split(' ')[0] || hostName;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || status === 'submitting') return;
    setStatus('submitting');
    try {
      await askListingQuestion(listingId, trimmed, token);
      setStatus('success');
      capture('listing_question_ask', { listing_id: listingId, outcome: 'success', status: 200 });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setStatus('already');
          capture('listing_question_ask', { listing_id: listingId, outcome: 'already_asked', status: 409 });
        } else if (err.status === 429) {
          setStatus('rate_limited');
          capture('listing_question_ask', { listing_id: listingId, outcome: 'rate_limited', status: 429 });
        } else if (err.status === 400) {
          setStatus('masked');
          capture('listing_question_ask', { listing_id: listingId, outcome: 'invalid', status: 400 });
        } else {
          setStatus('error');
          capture('listing_question_ask', { listing_id: listingId, outcome: 'error', status: err.status });
        }
      } else {
        setStatus('error');
        capture('listing_question_ask', { listing_id: listingId, outcome: 'error', status: 0 });
      }
    }
  }

  const wrap: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 10, fontFamily: 'Nunito, system-ui, sans-serif',
    padding: 16, borderRadius: 16, background: '#fff', border: '1.5px solid rgba(22,22,20,.15)',
  };
  const caption: React.CSSProperties = { margin: 0, fontWeight: 800, fontSize: '0.75rem', letterSpacing: '.04em', color: '#5a5a54' };

  if (token === undefined) {
    // Still resolving whether there's a session — render nothing rather than
    // flash a sign-in link that a signed-in visitor will never see.
    return <div style={wrap} aria-hidden="true" />;
  }

  if (!token) {
    return (
      <div style={wrap} data-section="ask_host">
        <p style={caption}>{askHost.caption(hostFirstName)}</p>
        <p style={{ margin: 0, fontWeight: 700, fontSize: '0.8125rem', color: '#3a3a34' }}>{askHost.signInPrompt}</p>
        <a
          href={`/sign-in?next=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname : '/')}`}
          data-cta="ask_host_sign_in"
          style={{
            alignSelf: 'flex-start', textDecoration: 'none', fontWeight: 900, fontSize: '0.75rem', letterSpacing: '.06em',
            padding: '10px 18px', borderRadius: 100, border: '2px solid #161614', background: '#fdf1d3', color: '#161614',
          }}
        >
          {askHost.signIn}
        </a>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div style={wrap} data-section="ask_host">
        <p style={caption}>{askHost.caption(hostFirstName)}</p>
        <p style={{ margin: 0, fontWeight: 800, fontSize: '0.875rem', color: '#1e8f5f' }}>{askHost.success}</p>
      </div>
    );
  }

  if (status === 'already') {
    return (
      <div style={wrap} data-section="ask_host">
        <p style={caption}>{askHost.caption(hostFirstName)}</p>
        <p style={{ margin: 0, fontWeight: 700, fontSize: '0.8125rem', color: '#5a5a54' }}>{askHost.alreadyAsked}</p>
      </div>
    );
  }

  return (
    <form style={wrap} onSubmit={submit} data-section="ask_host">
      <p style={caption}>{askHost.caption(hostFirstName)}</p>
      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value.slice(0, 300))}
        placeholder={askHost.placeholder}
        rows={2}
        maxLength={300}
        disabled={status === 'submitting'}
        style={{
          resize: 'vertical', fontFamily: 'inherit', fontWeight: 600, fontSize: '0.8125rem', padding: '10px 12px',
          borderRadius: 12, border: '1.5px solid #161614', color: '#161614', background: '#fdf7e8',
        }}
      />
      {status === 'rate_limited' && <p style={{ margin: 0, fontWeight: 700, fontSize: '0.75rem', color: '#d93825' }}>{askHost.rateLimited}</p>}
      {status === 'masked' && <p style={{ margin: 0, fontWeight: 700, fontSize: '0.75rem', color: '#d93825' }}>{askHost.masked}</p>}
      {status === 'error' && <p style={{ margin: 0, fontWeight: 700, fontSize: '0.75rem', color: '#d93825' }}>{askHost.error}</p>}
      <button
        type="submit"
        data-cta="ask_host_submit"
        disabled={status === 'submitting' || !question.trim()}
        style={{
          alignSelf: 'flex-start', fontWeight: 900, fontSize: '0.75rem', letterSpacing: '.06em',
          padding: '10px 20px', borderRadius: 100, border: '2px solid #161614',
          background: status === 'submitting' ? '#e8e2d0' : '#161614', color: status === 'submitting' ? '#161614' : '#fdf1d3',
          cursor: status === 'submitting' || !question.trim() ? 'not-allowed' : 'pointer',
        }}
      >
        {status === 'submitting' ? askHost.submitting : askHost.submit}
      </button>
    </form>
  );
}

export default function AskHost(props: AskHostProps) {
  return (
    <ClerkIsland>
      <AskHostInner {...props} />
    </ClerkIsland>
  );
}
