import { useTranslation as useUiTranslation } from "../lib/i18n/react";
import type { CSSProperties } from 'react';

export interface SpinnerProps {
  /** Diameter in px. */
  size?: number;
  /** Stroke color (CSS color or zine var). Defaults to ink. */
  color?: string;
  className?: string;
}

/** Minimal ring spinner — used in buttons and loading states. */
export function Spinner({ size = 20, color = 'var(--zine-ink)', className }: SpinnerProps) {
  const {t:uiT}=useUiTranslation("web-common");

  const style: CSSProperties = {
    width: size,
    height: size,
    borderWidth: Math.max(2, Math.round(size / 8)),
    borderStyle: 'solid',
    borderColor: color,
    borderTopColor: 'transparent',
    borderRadius: '9999px',
    display: 'inline-block',
    animation: 'zine-spin 0.7s linear infinite',
  };
  return (
    <span className={className} role="status" aria-label={uiT("web-common.dc380888c4e2c776","Loading")} style={style}>
      <style>{uiT("web-common.f668e3de764c240e","@keyframes zine-spin{to{transform:rotate(360deg)}}")}</style>
    </span>
  );
}

export default Spinner;
