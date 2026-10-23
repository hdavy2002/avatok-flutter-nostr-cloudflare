/* [HF-CHANNEL-WEB-1] Meme sticker: the owner's painted PNG once its flag is on in lib/hfChannelArt.ts, otherwise the CSS stand-in from the mock. */
import { ART_DIMS, STICKER_SLOT, STICKER_TEXT, artUrl } from '../../lib/hfChannelArt';

type Key = keyof typeof STICKER_TEXT;
const TONE: Record<Key, string> = { merch: 'stk', videos: 'stk p', booking: 'stk b', reviews: 'stk', product: 'stk', bag: 'stk p' };

export default function Sticker({ k, size }: { k: Key; size?: number }) {
  const src = artUrl(STICKER_SLOT[k]);
  if (src) return <img className="stk-img" src={src} alt={STICKER_TEXT[k]} width={ART_DIMS[STICKER_SLOT[k]].w} height={ART_DIMS[STICKER_SLOT[k]].h} loading="lazy" decoding="async" style={size ? { width: size } : undefined} />;
  return <span className={TONE[k]} style={size ? { fontSize: size } : undefined}>{STICKER_TEXT[k]}</span>;
}
