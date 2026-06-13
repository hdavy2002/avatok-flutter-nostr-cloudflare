import { cfImage } from '../lib/config';

export interface AvatarProps {
  /** Image path or URL. Runs through the Cloudflare image-transform pattern. */
  src?: string | null;
  /** Fallback initials when no src. */
  name?: string | null;
  /** Pixel diameter. */
  size?: number;
  /** zine accent fill class for the fallback, default blue. */
  fallbackClassName?: string;
  className?: string;
}

function initials(name?: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

/**
 * Round avatar with ink border + hard shadow. Uses the Cloudflare image-transform
 * URL pattern (/cdn-cgi/image/format=avif,quality=60,width=N,fit=cover/<path>).
 */
export function Avatar({ src, name, size = 44, fallbackClassName = 'bg-blue', className = '' }: AvatarProps) {
  const px = { width: size, height: size };
  if (src) {
    return (
      <img
        src={cfImage(src, { width: Math.round(size * 2), fit: 'cover' })}
        alt={name ?? ''}
        width={size}
        height={size}
        loading="lazy"
        className={['rounded-full border-zine border-ink shadow-zine-xs object-cover bg-card', className].join(' ')}
        style={px}
      />
    );
  }
  return (
    <span
      aria-label={name ?? 'avatar'}
      className={[
        'inline-flex items-center justify-center rounded-full border-zine border-ink shadow-zine-xs',
        'font-display font-semibold text-ink',
        fallbackClassName,
        className,
      ].join(' ')}
      style={{ ...px, fontSize: Math.round(size * 0.4) }}
    >
      {initials(name)}
    </span>
  );
}

export default Avatar;
