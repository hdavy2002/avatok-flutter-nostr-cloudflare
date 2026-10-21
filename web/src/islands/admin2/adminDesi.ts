// [HF-ADMIN-DESI-1] The dashboard's Indian treatment for every admin screen: a Hinglish headline and one of the
// owner's desi stickers (/public/hf/stickers, same kit as the dashboard) per screen. The plain page name stays as the
// eyebrow above the headline, so every screen still says what it is. Read by layouts/Admin2.astro.
import type { AdminKey } from './nav';
import type { StickerName } from '../dashboard-hf/v3/ui';

export interface AdminDesi { line: string; sticker: StickerName; rot: number }

/** Stickers that are square posters (get a white frame like the dashboard's `.h3-stk.poster`). */
export const POSTER_STICKERS: ReadonlySet<StickerName> = new Set(['kachori', 'lkk', 'lotus', 'peace', 'girlboss', 'pco', 'nazar', 'chugli', 'kyabaat']);

export const ADMIN_DESI: Record<AdminKey, AdminDesi> = {
  overview: { line: 'Hisaab-kitaab, ek nazar mein', sticker: 'kyabaat', rot: -6 },
  events: { line: 'Aaj ka programme kya hai?', sticker: 'lotus', rot: 5 },
  freevideos: { line: 'Free mein dekho, dil se', sticker: 'swag', rot: -5 },
  bookings: { line: 'Kaun aa raha hai?', sticker: 'mehman', rot: -6 },
  payments: { line: 'Paisa bolta hai', sticker: 'kachori', rot: 5 },
  verify: { line: 'Pakka? Bank se poochh lo', sticker: 'nazar', rot: -5 },
  refunds: { line: 'Paisa wapas, tension khatam', sticker: 'peace', rot: 6 },
  customers: { line: 'Apne log, apni duniya', sticker: 'yaari', rot: -5 },
  wallets: { line: 'Kiski jeb mein kitna?', sticker: 'fav', rot: 5 },
  prices: { line: 'Daam sahi, kaam sahi', sticker: 'kachori', rot: -6 },
  chadhava: { line: 'Chadhava ki thaali', sticker: 'lotus', rot: 5 },
  upi: { line: 'UPI ka pata-thikana', sticker: 'pco', rot: -5 },
  ai: { line: 'Robot ji, namaste', sticker: 'chugli', rot: 5 },
  knowledge: { line: 'Gyaan ka bhandaar', sticker: 'mohmaya', rot: -5 },
  'voice-guides': { line: 'Awaaz ki duniya', sticker: 'chai', rot: 5 },
  'shop-orders': { line: 'Dukaan chalu hai', sticker: 'swag', rot: -5 },
  'shop-studio': { line: 'Design ka adda', sticker: 'girlboss', rot: 5 },
  'shop-partner': { line: 'Chhapai wale bhaiya', sticker: 'auto', rot: -5 },
  'shop-editor': { line: 'Dukaan ka chehra', sticker: 'fav', rot: 5 },
  'shop-products': { line: 'Maal-paani, sab yahan', sticker: 'kachori', rot: -5 },
  'shop-collections': { line: 'Sab apni jagah pe', sticker: 'mohmaya', rot: 5 },
  'shop-promote': { line: 'Thoda dikhawa banta hai', sticker: 'swag', rot: -5 },
  'shop-coupons': { line: 'Discount ka jugaad', sticker: 'kyabaat', rot: 5 },
  'shop-settings': { line: 'Dukaan ke niyam', sticker: 'chai', rot: -5 },
  consultants: { line: 'Gyaani log', sticker: 'mohmaya', rot: 5 },
  'consultant-bookings': { line: 'Kab, kaun, kitna?', sticker: 'mehman', rot: -5 },
  'consultant-reviews': { line: 'Log kya kahenge?', sticker: 'lkk', rot: 5 },
  'host-review': { line: 'Naye chehre, pehli nazar', sticker: 'nazar', rot: -5 },
  'host-kyc': { line: 'Pehchaan pakki karo', sticker: 'peace', rot: 5 },
  'host-avatars': { line: 'Chehre hazaar', sticker: 'fav', rot: -5 },
  'host-demo': { line: 'Dikhawe ke sitare', sticker: 'girlboss', rot: 5 },
  'host-reviews': { line: 'Log kya kahenge?', sticker: 'lkk', rot: -5 },
  'host-calls': { line: 'Kitni baatein hui?', sticker: 'pco', rot: 5 },
  'host-payouts': { line: 'Mehnat ki kamaai', sticker: 'yaari', rot: -5 },
  'host-refunds': { line: 'Paisa wapas, wallet se', sticker: 'auto', rot: 5 },
  'host-reconciliation': { line: 'Hisaab barabar?', sticker: 'chugli', rot: -5 },
  'host-phone-costs': { line: 'Phone ka bill, paai-paai', sticker: 'panipilo', rot: 5 },
  'preview-help': { line: 'Madad ka panna', sticker: 'chai', rot: -5 },
  'preview-legal': { line: 'Kaanoon ki kitaab', sticker: 'aalsi', rot: 5 },
};
