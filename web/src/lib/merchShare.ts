/* [HF-MERCH-FAN-WEB-1] Share links with UTM tags: ?utm_source=share&utm_medium=<network>. */
export type ShareNetwork = 'whatsapp' | 'x' | 'facebook' | 'instagram' | 'qr' | 'copy' | 'native';
export function shareUrl(base: string, network: ShareNetwork): string {
  const u = new URL(base);
  u.searchParams.set('utm_source', 'share');
  u.searchParams.set('utm_medium', network);
  return u.toString();
}
export const whatsappHref = (base: string, text: string): string => `https://wa.me/?text=${encodeURIComponent(`${text} ${shareUrl(base, 'whatsapp')}`)}`;
export const xHref = (base: string, text: string): string => `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl(base, 'x'))}`;
export const facebookHref = (base: string): string => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl(base, 'facebook'))}`;
