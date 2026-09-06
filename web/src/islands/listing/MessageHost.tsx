// [WEB-MSG-HANDOFF-1 2026-09-05] The web does NOT send messages. It hands the
// visitor the creator's AvaTOK number and sends them to the app.
//
// Owner decision: "I don't want users to send messages to creators using the
// web. If a user accesses this on the web, just show him the creator's AvaTOK
// number and ask him to message on that. If the user has the AvaTOK app
// installed, then you can open the message box."
//
// That is not a workaround for missing web messaging — it IS the product move.
// A buyer who wants to talk to a host is the single most motivated moment to
// ask for an app install, and messaging is app-only anyway (there is no web
// messenger; `web/src/pages/dashboard/inbox.astro` is a notification feed).
//
// What this replaces: an "Ask the host a question" form that wrote a
// `listing_questions` row and fired a push. Nothing read those rows — the
// creator-facing inbox route (`GET /api/questions/inbox`) has no client on any
// surface, web or app — so a buyer's question went into a table nobody opens.
// Better to send them somewhere a reply can actually happen.
//
// The handoff reuses `/add?n=<number>`, which already exists and already does
// the install dance: it tries `avatok://add?n=…` and falls back to the Play
// Store if nothing intercepts it. Deliberately NOT a new `avatok://msg` scheme —
// every already-installed app would fail to understand it, and a deep link that
// silently does nothing is worse than one that opens Add Contact with the
// number filled in, one tap from the conversation.
import { useState } from 'react';
import { capture } from '../../lib/analytics';

const PLAY_STORE = 'https://play.google.com/store/apps/details?id=ai.avatok.avatok_call';

export interface MessageHostProps {
  listingId: string;
  hostName: string;
  /** The creator's AvaTOK number, as it should be READ ALOUD. Null when they
   *  have not claimed one — see the fallback copy below. */
  hostNumber: string | null;
}

export default function MessageHost({ listingId, hostName, hostNumber }: MessageHostProps) {
  const [copied, setCopied] = useState(false);
  const first = hostName.split(' ')[0] || hostName;
  // Digits only for the deep link; the display keeps whatever spacing the
  // creator's number was formatted with.
  const digits = (hostNumber ?? '').replace(/[^0-9]/g, '');
  const addHref = digits ? `/add?n=${encodeURIComponent(digits)}` : '/add';

  async function copy() {
    if (!hostNumber) return;
    try {
      await navigator.clipboard.writeText(hostNumber);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      capture('listing_host_number_copied', { listing_id: listingId });
    } catch {
      // Clipboard is permission-gated and refused outright in some embedded
      // browsers. The number is on screen either way, so this is not an error
      // worth showing — it just means they type it.
    }
  }

  const wrap: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 12, fontFamily: 'Nunito, system-ui, sans-serif',
    padding: 16, borderRadius: 16, background: '#fff', border: '1.5px solid rgba(22,22,20,.15)',
  };
  const caption: React.CSSProperties = {
    margin: 0, fontWeight: 800, fontSize: '0.75rem', letterSpacing: '.04em', color: '#5a5a54',
  };

  if (!hostNumber) {
    // A creator with no number yet. Say so plainly rather than showing a button
    // that leads to an empty Add Contact screen.
    return (
      <div style={wrap} data-section="message_host">
        <p style={caption}>MESSAGE {first.toUpperCase()}</p>
        <p style={{ margin: 0, fontWeight: 700, fontSize: '0.8125rem', color: '#3a3a34' }}>
          {first} has not set up their AvaTOK number yet. Book a seat and you will be able to
          reach them from the app.
        </p>
        <a href={PLAY_STORE} target="_blank" rel="noreferrer" data-cta="get_app"
          style={{
            alignSelf: 'flex-start', textDecoration: 'none', fontWeight: 900, fontSize: '0.75rem',
            letterSpacing: '.06em', padding: '10px 18px', borderRadius: 100,
            border: '2px solid #161614', background: '#fdf1d3', color: '#161614',
          }}>
          GET THE APP
        </a>
      </div>
    );
  }

  return (
    <div style={wrap} data-section="message_host">
      <p style={caption}>MESSAGE {first.toUpperCase()} ON AVATOK</p>

      <button type="button" onClick={() => void copy()}
        title="Copy this number"
        style={{
          alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 10,
          fontFamily: 'Anton, Impact, sans-serif', fontSize: '1.5rem', letterSpacing: '.055em',
          padding: '8px 14px', borderRadius: 12, border: '2px dashed rgba(22,22,20,.3)',
          background: '#fdf1d3', color: '#161614', cursor: 'pointer',
        }}>
        {hostNumber}
        <span style={{ fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800, fontSize: '0.6875rem', letterSpacing: '.06em', color: '#5a5a54' }}>
          {copied ? 'COPIED' : 'TAP TO COPY'}
        </span>
      </button>

      <p style={{ margin: 0, fontWeight: 700, fontSize: '0.8125rem', color: '#3a3a34', lineHeight: 1.5 }}>
        Messages happen in the AvaTOK app. Open it and send {first} a message on this number —
        neither of you ever sees the other's real phone number.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <a
          href={addHref}
          data-cta="message_host_open_app"
          onClick={() => capture('listing_message_host', { listing_id: listingId, action: 'open_app' })}
          style={{
            textDecoration: 'none', fontWeight: 900, fontSize: '0.75rem', letterSpacing: '.06em',
            padding: '11px 20px', borderRadius: 100, border: '2px solid #161614',
            background: '#161614', color: '#fdf1d3',
          }}
        >
          OPEN IN AVATOK
        </a>
        <a
          href={PLAY_STORE}
          target="_blank"
          rel="noreferrer"
          data-cta="message_host_get_app"
          onClick={() => capture('listing_message_host', { listing_id: listingId, action: 'get_app' })}
          style={{
            textDecoration: 'none', fontWeight: 900, fontSize: '0.75rem', letterSpacing: '.06em',
            padding: '11px 20px', borderRadius: 100, border: '2px solid #161614',
            background: '#fdf1d3', color: '#161614',
          }}
        >
          GET THE APP
        </a>
      </div>
    </div>
  );
}
