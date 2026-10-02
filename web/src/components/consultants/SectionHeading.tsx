// [AUMFE-CONSULT-F1-1 2026-10-02] Centered section heading: Devanagari line, Comfortaa title, lotus divider (CSS ::after).
import type { CSSProperties, ReactNode } from 'react';

export default function SectionHeading({ deva, title, titleMobile, children, className = '' }: { deva: string; title: string; titleMobile?: string; children?: ReactNode; className?: string }) {
  return (
    <div className={`sec-h ${className}`.trim()}>
      <span className="deva">{deva}</span>
      {titleMobile ? <><h2 className="cp-d">{title}</h2><h2 className="cp-m">{titleMobile}</h2></> : <h2>{title}</h2>}
      {children}
    </div>
  );
}

/** Left-aligned heading used inside cards: small Devanagari line over a Comfortaa title. */
export function CardHeading({ deva, title, titleMobile, size = 26 }: { deva: string; title: string; titleMobile?: string; size?: number }) {
  return (
    <div className="cp-cardhead" style={{ ['--hs' as string]: `${size}px` } as CSSProperties}>
      <span className="deva">{deva}</span>
      {titleMobile ? <><h2 className="cp-d">{title}</h2><h2 className="cp-m">{titleMobile}</h2></> : <h2>{title}</h2>}
    </div>
  );
}
