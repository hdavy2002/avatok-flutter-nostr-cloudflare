// [LIST-PAGE-2] "SHARE THE SHOW" box (SPEC-2026-09-01 comp order; SPEC-2026-09-02
// §1 row 15 — WhatsApp first). A small client island because copy-to-clipboard and
// the WhatsApp/Facebook share links need `window.location`/`navigator.clipboard`,
// which don't exist at SSR time.
//
// The QR code (comp: "SCAN TO OPEN THIS SHOW ON YOUR PHONE") lives in the
// sibling `QrCode.tsx` island, rendered client-side via the `qrcode` package —
// see ListingDetailView.astro's `.share-box-row`, which places it next to this
// component rather than folding it in here.
import { useState } from 'react';
import { shareCopy } from '../../lib/copy';
import { capture } from '../../lib/analytics';

export interface ShareBoxProps {
  listingId: string;
  url: string;
  title: string;
}

export default function ShareBox({ listingId, url, title }: ShareBoxProps) {
  const [copied, setCopied] = useState(false);

  const fire = (channel: string) => capture('listing_share', { listing_id: listingId, channel });

  const whatsappHref = `https://wa.me/?text=${encodeURIComponent(`${title} — ${url}`)}`;
  const facebookHref = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
  const youtubeHref = 'https://youtube.com/upload';
  const embedCode = `<iframe src="${url}" width="360" height="640" frameborder="0"></iframe>`;

  const copyLink = async () => {
    fire('copy_link');
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard API unavailable (older browser, non-secure context) — the link
      // is still visible in the input below for a manual copy.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyEmbed = async () => {
    fire('embed');
    try {
      await navigator.clipboard.writeText(embedCode);
    } catch { /* see copyLink */ }
  };

  const btn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800, fontSize: '0.75rem',
    letterSpacing: '.06em', padding: '12px 10px', borderRadius: 100,
    border: '2px solid #161614', background: '#fdf1d3', color: '#161614',
    textDecoration: 'none', cursor: 'pointer',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <a href={whatsappHref} target="_blank" rel="noopener" style={{ ...btn, background: '#25D366', color: '#0b2e17' }} onClick={() => fire('whatsapp')}>
          {shareCopy.whatsapp}
        </a>
        <a href={facebookHref} target="_blank" rel="noopener" style={btn} onClick={() => fire('facebook')}>
          {shareCopy.facebook}
        </a>
        <a href={youtubeHref} target="_blank" rel="noopener" style={btn} onClick={() => fire('youtube')}>
          {shareCopy.youtube}
        </a>
        <button type="button" style={btn} onClick={copyEmbed}>{shareCopy.embed}</button>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            flex: 1, minWidth: 0, fontFamily: 'Nunito, system-ui, sans-serif', fontSize: '0.75rem',
            fontWeight: 700, padding: '10px 12px', borderRadius: 100, border: '1.5px solid #161614',
            background: '#fff', color: '#161614',
          }}
        />
        <button type="button" onClick={copyLink} style={{ ...btn, background: '#161614', color: '#fdf1d3', flex: 'none', padding: '10px 16px' }}>
          {copied ? shareCopy.copied : shareCopy.copyLink}
        </button>
      </div>
    </div>
  );
}
