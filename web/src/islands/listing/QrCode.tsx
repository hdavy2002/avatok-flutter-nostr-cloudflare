// [LIST-PAGE-2 gap 3] "SCAN TO OPEN THIS SHOW ON YOUR PHONE" — comp:
// design/live-streaming/avaTOK Listing Details.dc.html:170-172. The comp used a
// third-party image proxy (api.qrserver.com) to render the code, which is a
// live external dependency this repo shouldn't hard-wire into a production
// page (an outage there blanks the code, and it round-trips the listing URL to
// a server we don't run). `qrcode@1.5.4` (added to package.json this change —
// see CLAUDE.md ship notes) renders the same QR entirely client-side onto a
// <canvas>, no network call.
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { shareCopy } from '../../lib/copy';

export interface QrCodeProps {
  url: string;
  /** Pixel size of the square canvas. The comp draws it at 88x88. */
  size?: number;
}

export default function QrCodeBox({ url, size = 88 }: QrCodeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    QRCode.toCanvas(canvas, url, {
      width: size,
      margin: 0,
      errorCorrectionLevel: 'M',
      color: { dark: '#161614', light: '#ffffff' },
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [url, size]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {!failed ? (
        <canvas
          ref={canvasRef}
          width={size}
          height={size}
          style={{ width: size, height: size, display: 'block', borderRadius: 8, border: '1.5px solid #161614', background: '#fff' }}
        />
      ) : (
        <div
          style={{
            width: size, height: size, display: 'grid', placeItems: 'center', borderRadius: 8,
            border: '1.5px solid #161614', background: '#fff', fontSize: '0.625rem', fontWeight: 800, textAlign: 'center', padding: 4,
          }}
        >
          QR unavailable
        </div>
      )}
      <span style={{
        fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800, fontSize: '0.625rem',
        letterSpacing: '.08em', color: '#8c6a52', lineHeight: 1.5, maxWidth: 90,
      }}>
        {shareCopy.scanToOpen}
      </span>
    </div>
  );
}
