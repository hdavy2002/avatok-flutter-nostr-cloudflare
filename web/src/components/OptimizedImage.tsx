import type { ImgHTMLAttributes } from 'react';
import { publicImage, publicImageSrcSet } from '../lib/config';
type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'width' | 'height'> & {
  src: string; alt: string; width: number; height: number;
  widths?: number[]; eager?: boolean; fit?: 'cover' | 'contain' | 'scale-down';
};
/** For public website artwork; use cfImage for public API media. */
export function OptimizedImage({ src, alt, width, height, widths = [256, 420, 640, 900, 1280, 1600],
  eager = false, fit = 'contain', sizes = '100vw', ...rest }: Props) {
  return <img {...rest} src={publicImage(src, { width, fit })}
    srcSet={publicImageSrcSet(src, widths, { fit })} sizes={sizes}
    width={width} height={height} alt={alt} loading={eager ? 'eager' : 'lazy'}
    fetchPriority={eager ? 'high' : 'auto'} decoding="async" />;
}
