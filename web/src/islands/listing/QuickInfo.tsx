/* [POSTER-FIRST-1 2026-09-05] The "More info" panel.
 *
 * The poster carries a title and a tagline and nothing else, deliberately: no
 * price, no duration, no house rules ever pass through an image model, because
 * a model that letters "₹250" as "₹25O" turns a cosmetic glitch into a money
 * bug. Every one of those facts lives HERE instead, as real HTML text read
 * straight off the listing row — selectable, translatable, screen-readable, and
 * correct by construction.
 *
 * Visually it is the back of the same printed object: poster-paper ground, the
 * same ink palette, the same type stack. It reads as the flip side of the card,
 * not as a web dialog that happened to open on top of it.
 *
 * Type follows the CLAUDE.md standing rules — Anton for display, Nunito for
 * labels, tracking always POSITIVE on bold and display faces, never negative.
 */
import { useEffect, useMemo } from 'react';
import { Modal } from '../../components/Modal';
import { priceLabel, languageLabel } from '../../lib/card';
import type { CardView, Listing } from '../../lib/types';
import { capture } from '../../lib/analytics';

const INK = '#20160f';
const PAPER = '#f6efe1';
const RULE = '#d9cdb6';
const RED = '#d93825';

export interface QuickInfoProps {
  card: CardView;
  /** Full detail row, fetched on open. Null until it lands — the panel renders
   *  from the card meanwhile rather than showing a spinner over facts it
   *  already has. */
  listing: Listing | null;
  lane: string;
  href: string;
  onClose: () => void;
  onBook: () => void;
}

const labelStyle = {
  fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 900,
  fontSize: '0.6875rem', letterSpacing: '.14em', textTransform: 'uppercase' as const,
  color: '#8a7a63', margin: 0,
};
const valueStyle = {
  fontFamily: 'Anton, Impact, sans-serif', fontWeight: 400,
  fontSize: '1.125rem', letterSpacing: '.045em', textTransform: 'uppercase' as const,
  color: INK, margin: '3px 0 0',
};
const bodyStyle = {
  fontFamily: 'Instrument Sans, system-ui, sans-serif', fontSize: '0.9375rem',
  lineHeight: 1.5, color: '#3d3226', margin: 0,
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <p style={labelStyle}>{label}</p>
      <p style={valueStyle}>{value}</p>
    </div>
  );
}

function minutesLabel(min: number | null): string | null {
  if (!min || min <= 0) return null;
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hour${h === 1 ? '' : 's'}`;
}

function whenLabel(startsAt: number | null): string | null {
  if (!startsAt) return null;
  try {
    // Seconds vs milliseconds: rows carry both historically, and reading a
    // seconds value as ms lands the date in 1970 — visibly wrong, silently
    // produced. Anything below ~year 2001 in ms must have been seconds.
    const ms = startsAt < 1e11 ? startsAt * 1000 : startsAt;
    return new Date(ms).toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  } catch { return null; }
}

export function QuickInfo({ card: c, listing, lane, href, onClose, onBook }: QuickInfoProps) {
  useEffect(() => {
    capture('listing_quick_info_open', { listing_id: c.id, kind: c.kind ?? null, lane });
  }, [c.id, c.kind, lane]);

  const attrs = (listing?.attrs ?? null) as Record<string, unknown> | null;
  const rules = useMemo(() => {
    const raw = attrs?.content_house_rules;
    return Array.isArray(raw) ? raw.map((r) => String(r)).filter(Boolean).slice(0, 6) : [];
  }, [attrs]);
  const expect = useMemo(() => {
    const raw = attrs?.content_what_you_get;
    return Array.isArray(raw) ? raw.map((r) => String(r)).filter(Boolean).slice(0, 5) : [];
  }, [attrs]);

  // Same helper the card uses, so the popup can never quote a different price
  // than the tile that opened it.
  const price = priceLabel(c.price, listing?.price_semantics ?? null, listing?.billing_unit ?? null);
  const duration = minutesLabel(c.durationMin);
  const when = whenLabel(c.startsAt);
  const language = languageLabel(c.spokenLang);
  const about = listing?.description ?? c.oneLiner ?? null;

  return (
    <Modal open dismissable maxWidth={520} onClose={onClose} title={null}>
      <div style={{ background: PAPER, margin: -1, borderRadius: 18, overflow: 'hidden' }}>
        <div style={{ padding: '22px 22px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{ ...labelStyle, color: RED }}>{c.category ?? c.kind ?? 'Listing'}</p>
              <h2 style={{
                fontFamily: 'Anton, Impact, sans-serif', fontWeight: 400, fontSize: '1.75rem',
                lineHeight: 1.1, letterSpacing: '.055em', wordSpacing: '.1em',
                textTransform: 'uppercase', color: INK, margin: '6px 0 0',
              }}>{c.title}</h2>
              {c.oneLiner && (
                <p style={{ ...bodyStyle, margin: '8px 0 0', fontWeight: 600 }}>{c.oneLiner}</p>
              )}
            </div>
            <button type="button" aria-label="Close" onClick={onClose} style={{
              flex: 'none', width: 32, height: 32, borderRadius: '50%', border: `2px solid ${INK}`,
              background: 'transparent', color: INK, fontSize: '1.125rem', lineHeight: 1, cursor: 'pointer',
            }}>×</button>
          </div>

          <div style={{ height: 1, background: RULE, margin: '18px 0' }} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '16px 18px' }}>
            {price && <Row label="Price" value={price} />}
            {duration && <Row label="Duration" value={duration} />}
            {when && <Row label="Date & time" value={when} />}
            {language && <Row label="Language" value={language} />}
            {c.location && <Row label="Location" value={c.location} />}
            {c.seatsLeft != null && <Row label="Seats left" value={String(c.seatsLeft)} />}
          </div>

          {about && (
            <>
              <div style={{ height: 1, background: RULE, margin: '18px 0' }} />
              <p style={labelStyle}>About</p>
              <p style={{ ...bodyStyle, marginTop: 6 }}>{about}</p>
            </>
          )}

          {expect.length > 0 && (
            <>
              <div style={{ height: 1, background: RULE, margin: '18px 0' }} />
              <p style={labelStyle}>What to expect</p>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {expect.map((e, i) => <li key={i} style={{ ...bodyStyle, marginTop: 4 }}>{e}</li>)}
              </ul>
            </>
          )}

          {rules.length > 0 && (
            <>
              <div style={{ height: 1, background: RULE, margin: '18px 0' }} />
              <p style={labelStyle}>Boundaries &amp; house rules</p>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {rules.map((r, i) => <li key={i} style={{ ...bodyStyle, marginTop: 4 }}>{r}</li>)}
              </ul>
            </>
          )}

          {/* Only claimed once the detail row has actually arrived. Saying
              "no house rules" while the fetch is still in flight would be a
              statement about the listing that we cannot yet make. */}
          {!listing && (
            <p style={{ ...bodyStyle, marginTop: 14, color: '#8a7a63' }}>Loading the rest…</p>
          )}
        </div>

        <div style={{
          display: 'flex', gap: 10, padding: '14px 22px 20px', borderTop: `1px solid ${RULE}`,
        }}>
          <button type="button" onClick={onBook} style={{
            flex: 1, fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 900,
            fontSize: '0.8125rem', letterSpacing: '.08em', padding: '13px 8px', borderRadius: 100,
            border: `2px solid ${INK}`, background: RED, color: PAPER, cursor: 'pointer',
          }}>BOOK NOW</button>
          <a href={href} style={{
            flex: 1, textAlign: 'center', textDecoration: 'none',
            fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 900,
            fontSize: '0.8125rem', letterSpacing: '.08em', padding: '13px 8px', borderRadius: 100,
            border: `2px solid ${INK}`, background: 'transparent', color: INK,
          }}>DETAILS</a>
        </div>
      </div>
    </Modal>
  );
}

export default QuickInfo;
