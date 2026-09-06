// [REVIEW-MOD-1 2026-09-06] "Leave a review" — the whole flow, in place.
//
// Owner's brief: "the middle of this reviews [section] is looking very empty.
// Create the button to leave a review. When clicked, ensure the person has
// registered for the show and paid up. Then show the flow to leave a review.
// Everything should happen within browser and the space of review area. When
// submitted, send it to admin for review."
//
// So: no navigation, no modal over the page, no separate route. The button, the
// form and every outcome render inside this one box, which sits in the empty
// column of the reviews section.
//
// THE GATE IS THE SERVER'S, NOT THIS COMPONENT'S. This asks
// /reviews/eligibility, which runs the exact same attendanceFor() check the POST
// enforces (worker/src/routes/reviews.ts). It is why the button can never offer
// a form the write would refuse. Hiding a form is not a permission check —
// anyone can POST — and that is precisely why the check lives on the server and
// this only decides what to draw.
//
// Everything written here lands 'pending' and is invisible until an admin
// approves it in /admin/reviews. So the success state must NOT say "posted" or
// drop the review into the list above; saying a review is live when it is
// queued is the same class of lie as a review tick that fired on a request
// returning rather than on a verdict.
import { useCallback, useEffect, useState } from 'react';
import { createListingReview, getReviewEligibility } from '../../lib/apiClient';
import { capture } from '../../lib/analytics';
import type { ReviewEligibility } from '../../lib/types';

export interface LeaveReviewProps {
  listingId: string;
  /** Host's first name, for the prompt copy. */
  hostName?: string | null;
}

const MAX_BODY = 2000;

/** The page's Clerk session, via the bridge ClerkIsland installs
 *  (lib/clerk.tsx). AuthBridge mounts client:load on the listing page, but this
 *  island can paint first, so the getter may not exist for a beat — hence the
 *  optional call rather than an assumption. A missing token is not an error: the
 *  eligibility route answers `signed_out` for a guest. */
async function token(): Promise<string | null> {
  try {
    const fn = (window as any).__avatokToken as undefined | (() => Promise<string | null>);
    return fn ? await fn() : null;
  } catch {
    return null;
  }
}

export default function LeaveReview({ listingId, hostName }: LeaveReviewProps) {
  const [elig, setElig] = useState<ReviewEligibility | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const load = useCallback(async () => {
    try {
      const e = await getReviewEligibility(listingId, await token());
      setElig(e);
      if (e.mine) { setRating(e.mine.rating); setBody(e.mine.body ?? ''); }
    } catch {
      // A failed eligibility read must not put a broken box on a public page.
      // Leaving `elig` null renders nothing at all, exactly as before this
      // feature existed.
      setElig(null);
    } finally {
      setLoading(false);
    }
  }, [listingId]);

  useEffect(() => { void load(); }, [load]);

  async function submit() {
    if (rating < 1) { setError('Pick a star rating first.'); return; }
    setBusy(true); setError(null);
    try {
      await createListingReview(listingId, { rating, body: body.trim() || undefined }, await token());
      setSubmitted(true);
      setOpen(false);
      capture('listing_review_submitted', { listing_id: listingId, rating, has_body: !!body.trim() });
      void load(); // pull back the stored row so the pending card shows the real thing
    } catch (e: any) {
      // The server's own words where they are useful, plain English where they
      // are not. `not_attendee` reaching here means eligibility and the write
      // disagreed — worth saying honestly rather than a generic failure.
      const code = String(e?.error ?? e?.message ?? '');
      setError(
        code.includes('not_attendee') ? 'We could not find your ticket for this show.'
          : code.includes('rating') ? 'Pick a star rating first.'
          : 'Could not send your review. Please try again.',
      );
      capture('listing_review_submit_failed', { listing_id: listingId, reason: code.slice(0, 80) });
    } finally {
      setBusy(false);
    }
  }

  if (loading || !elig) return null;

  const first = (hostName || '').split(' ')[0];
  const mine = elig.mine;
  const pending = submitted || mine?.status === 'pending';

  // ---- styles: matched to the reviews section's cards (listing-details.css
  // .ld-card / .ld-pager-btn), inline so this island carries no CSS build dep.
  const card: React.CSSProperties = {
    fontFamily: 'Nunito, system-ui, sans-serif', background: '#fdf1d3',
    border: '2px solid #161614', borderRadius: 16, boxShadow: '4px 5px 0 #161614',
    padding: 20, display: 'flex', flexDirection: 'column', gap: 12,
  };
  const eyebrow: React.CSSProperties = {
    margin: 0, fontWeight: 900, fontSize: '0.7rem', letterSpacing: '0.14em',
    textTransform: 'uppercase', color: '#5a5a54',
  };
  const btn: React.CSSProperties = {
    fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 900, fontSize: '0.78rem',
    letterSpacing: '0.08em', textTransform: 'uppercase', border: '2px solid #161614',
    borderRadius: 100, padding: '11px 20px', background: '#f2b705', color: '#161614',
    boxShadow: '3px 3px 0 #161614', cursor: 'pointer', alignSelf: 'flex-start',
  };
  const note: React.CSSProperties = { margin: 0, fontWeight: 700, fontSize: '0.9rem', color: '#3d3d38', lineHeight: 1.45 };

  // ---- 1. Already sent, waiting on an admin. -------------------------------
  if (pending) {
    return (
      <div style={card} data-review-state="pending">
        <p style={eyebrow}>Thanks — received</p>
        <p style={note}>
          Your {mine?.rating ?? rating}★ review is with our team for a quick check. It appears here once
          it is approved. Nobody else can see it yet.
        </p>
        {mine?.body && <p style={{ ...note, fontStyle: 'italic', opacity: 0.85 }}>“{mine.body}”</p>}
      </div>
    );
  }

  // ---- 2. Turned down — say why, and let them rewrite it. ------------------
  if (mine?.status === 'rejected') {
    return (
      <div style={card} data-review-state="rejected">
        <p style={eyebrow}>Not published</p>
        <p style={note}>
          Your review was not published{mine.moderation_reason ? `: ${mine.moderation_reason}` : '.'}
        </p>
        <button type="button" style={btn} onClick={() => setOpen(true)}>Write it again</button>
        {open && renderForm()}
      </div>
    );
  }

  // ---- 3. Not allowed to write one. ---------------------------------------
  if (!elig.can_review) {
    return (
      <div style={card} data-review-state={elig.reason ?? 'blocked'}>
        <p style={eyebrow}>Reviews</p>
        <p style={note}>
          {elig.reason === 'own_listing'
            // The host, looking at their own show. Rendering NOTHING here reads
            // as a broken page — especially to whoever is testing, who is
            // usually signed in as the host. Say it plainly instead.
            ? 'This is your show — reviews here come from the people who booked it.'
            : elig.reason === 'signed_out'
            ? 'Reviews come from people who booked this show. Sign in with the account you booked with to leave one.'
            : 'Only people who booked and paid for this show can review it.'}
        </p>
      </div>
    );
  }

  // ---- 4. Eligible: the button, then the form, in the same box. ------------
  return (
    <div style={card} data-review-state="eligible">
      {!open ? (
        <>
          <p style={eyebrow}>You went to this one</p>
          <p style={note}>
            {mine ? 'You can update your review.' : `How was it? Tell people what ${first || 'the host'} was actually like.`}
          </p>
          <button
            type="button"
            style={btn}
            onClick={() => { setOpen(true); capture('listing_review_open', { listing_id: listingId }); }}
          >
            {mine ? 'Edit your review' : 'Leave a review'}
          </button>
        </>
      ) : (
        renderForm()
      )}
    </div>
  );

  // ⚠️ A FUNCTION THAT RETURNS JSX, CALLED AS `{renderForm()}` — deliberately NOT
  // a component rendered as `<ReviewForm />`.
  //
  // It was the latter, and typing in the textarea threw the page to the bottom
  // after every character. Declaring a component inside another component makes
  // a NEW function identity on every render, and React compares element types by
  // identity: same-looking tree, different type, so it unmounts the old subtree
  // and mounts a fresh one. Each keystroke therefore destroyed and rebuilt the
  // textarea — losing focus, and with it the caret and the scroll position.
  //
  // Calling it instead inlines the JSX into THIS component's tree, so the
  // textarea is the same DOM node from the first keystroke to the last. Do not
  // "tidy" this back into a nested component, and do not reach for autoFocus or
  // a scroll-restore hack to paper over it — those treat the symptom of a
  // remount that should not be happening at all.
  function renderForm() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={eyebrow}>Your rating</p>
        <div style={{ display: 'flex', gap: 4 }} role="radiogroup" aria-label="Star rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} star${n === 1 ? '' : 's'}`}
              onClick={() => { setRating(n); setError(null); }}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(0)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                fontSize: '1.9rem', lineHeight: 1,
                color: n <= (hover || rating) ? '#f2b705' : 'rgba(22,22,20,.22)',
              }}
            >
              ★
            </button>
          ))}
        </div>

        <label style={eyebrow} htmlFor="leave-review-body">In your words (optional)</label>
        <textarea
          id="leave-review-body"
          value={body}
          maxLength={MAX_BODY}
          onChange={(e) => setBody(e.target.value.slice(0, MAX_BODY))}
          rows={4}
          placeholder="What actually happened? What would you tell a friend?"
          style={{
            fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 700, fontSize: '0.95rem',
            padding: 12, borderRadius: 12, border: '2px solid #161614', background: '#fff',
            resize: 'vertical', color: '#161614',
          }}
        />

        {error && (
          <p role="alert" style={{ ...note, color: '#a5231b', fontWeight: 800 }}>{error}</p>
        )}

        <p style={{ ...note, fontSize: '0.78rem', opacity: 0.8 }}>
          Reviews are checked by our team before they go up.
        </p>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" style={{ ...btn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>
            {busy ? 'Sending…' : 'Send for review'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => { setOpen(false); setError(null); }}
            style={{ ...btn, background: '#fdf1d3' }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }
}
