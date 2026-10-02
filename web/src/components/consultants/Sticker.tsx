// [AUMFE-CONSULT-F1-1 2026-10-02] Round white-bordered portrait ("sticker") from the approved mockup. Size via CSS class/prop.
import type { CSSProperties } from 'react';

interface Props { src: string; alt: string; size?: number; className?: string; style?: CSSProperties; eager?: boolean }

export default function Sticker({ src, alt, size, className = '', style, eager }: Props) {
  const dim: CSSProperties = size ? { width: size, height: size } : {};
  return (
    <img
      className={`sticker ${className}`.trim()}
      src={src}
      alt={alt}
      width={size}
      height={size}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      style={{ ...dim, ...style }}
    />
  );
}
