// [HF-ADMIN-DESI-1] The dashboard's Indian treatment for every admin screen: a Hinglish headline and one of the
// owner's desi stickers (/public/hf/stickers, same kit as the dashboard) per screen. The plain page name stays as the
// eyebrow above the headline, so every screen still says what it is. Read by layouts/Admin2.astro.
import type { AdminKey } from './nav';
import type { StickerName } from '../dashboard-hf/v3/ui';

export type HeroTone = 'saffron' | 'rani' | 'lav' | 'tea' | 'gold' | 'plum';
export interface AdminDesi { line: string; sticker: StickerName; rot: number; /** [HF-ADMIN-DESI-2] hero wash */ tone: HeroTone; /** giant outline word behind the hero */ ghost: string }

/** Stickers that are square posters (get a white frame like the dashboard's `.h3-stk.poster`). */
export const POSTER_STICKERS: ReadonlySet<StickerName> = new Set(['kachori', 'lkk', 'lotus', 'peace', 'girlboss', 'pco', 'nazar', 'chugli', 'kyabaat']);

export const ADMIN_DESI: Record<AdminKey, AdminDesi> = {
overview: { line: 'Hisaab-kitaab, ek nazar mein', sticker: 'kyabaat', rot: -6, tone: 'saffron', ghost: 'Hisaab' },
events: { line: 'Aaj ka programme kya hai?', sticker: 'lotus', rot: 5, tone: 'rani', ghost: 'Utsav' },
freevideos: { line: 'Free mein dekho, dil se', sticker: 'swag', rot: -5, tone: 'lav', ghost: 'Muft' },
bookings: { line: 'Kaun aa raha hai?', sticker: 'mehman', rot: -6, tone: 'rani', ghost: 'Mehmaan' },
payments: { line: 'Paisa bolta hai', sticker: 'kachori', rot: 5, tone: 'gold', ghost: 'Paisa' },
verify: { line: 'Pakka? Bank se poochh lo', sticker: 'nazar', rot: -5, tone: 'plum', ghost: 'Pakka' },
refunds: { line: 'Paisa wapas, tension khatam', sticker: 'peace', rot: 6, tone: 'tea', ghost: 'Wapas' },
customers: { line: 'Apne log, apni duniya', sticker: 'yaari', rot: -5, tone: 'lav', ghost: 'Log' },
wallets: { line: 'Kiski jeb mein kitna?', sticker: 'fav', rot: 5, tone: 'gold', ghost: 'Jeb' },
prices: { line: 'Daam sahi, kaam sahi', sticker: 'kachori', rot: -6, tone: 'saffron', ghost: 'Daam' },
chadhava: { line: 'Chadhava ki thaali', sticker: 'lotus', rot: 5, tone: 'rani', ghost: 'Thaali' },
upi: { line: 'UPI ka pata-thikana', sticker: 'pco', rot: -5, tone: 'tea', ghost: 'UPI' },
ai: { line: 'Robot ji, namaste', sticker: 'chugli', rot: 5, tone: 'lav', ghost: 'Robot' },
knowledge: { line: 'Gyaan ka bhandaar', sticker: 'mohmaya', rot: -5, tone: 'gold', ghost: 'Gyaan' },
'voice-guides': { line: 'Awaaz ki duniya', sticker: 'chai', rot: 5, tone: 'lav', ghost: 'Awaaz' },
'shop-orders': { line: 'Dukaan chalu hai', sticker: 'swag', rot: -5, tone: 'saffron', ghost: 'Dukaan' },
'shop-studio': { line: 'Design ka adda', sticker: 'girlboss', rot: 5, tone: 'rani', ghost: 'Design' },
'shop-partner': { line: 'Chhapai wale bhaiya', sticker: 'auto', rot: -5, tone: 'gold', ghost: 'Chhapai' },
'shop-editor': { line: 'Dukaan ka chehra', sticker: 'fav', rot: 5, tone: 'lav', ghost: 'Chehra' },
'shop-products': { line: 'Maal-paani, sab yahan', sticker: 'kachori', rot: -5, tone: 'saffron', ghost: 'Maal' },
'shop-collections': { line: 'Sab apni jagah pe', sticker: 'mohmaya', rot: 5, tone: 'tea', ghost: 'Jagah' },
'shop-promote': { line: 'Thoda dikhawa banta hai', sticker: 'swag', rot: -5, tone: 'rani', ghost: 'Dikhawa' },
'shop-coupons': { line: 'Discount ka jugaad', sticker: 'kyabaat', rot: 5, tone: 'gold', ghost: 'Jugaad' },
'shop-settings': { line: 'Dukaan ke niyam', sticker: 'chai', rot: -5, tone: 'lav', ghost: 'Niyam' },
consultants: { line: 'Gyaani log', sticker: 'mohmaya', rot: 5, tone: 'tea', ghost: 'Gyaani' },
'consultant-bookings': { line: 'Kab, kaun, kitna?', sticker: 'mehman', rot: -5, tone: 'rani', ghost: 'Kab' },
'consultant-reviews': { line: 'Log kya kahenge?', sticker: 'lkk', rot: 5, tone: 'lav', ghost: 'Log' },
'desk-wallets': { line: 'Kiski jeb mein kitna?', sticker: 'fav', rot: 5, tone: 'gold', ghost: 'Jeb' },
'desk-bookings': { line: 'Kaun kisse milne wala hai?', sticker: 'mehman', rot: -6, tone: 'rani', ghost: 'Mehmaan' },
'desk-topups': { line: 'Paisa aaya, wallet bhara', sticker: 'kachori', rot: 5, tone: 'gold', ghost: 'Paisa' },
'desk-support': { line: 'Kisi ne kuch poochha hai', sticker: 'chai', rot: -5, tone: 'lav', ghost: 'Sawaal' },
'desk-reports': { line: 'Shikayat? Pehle suno', sticker: 'nazar', rot: 5, tone: 'plum', ghost: 'Suno' },
'desk-money': { line: 'Hisaab mein gadbad?', sticker: 'chugli', rot: -5, tone: 'gold', ghost: 'Hisaab' },
'host-desk': { line: 'Kaun aaya, kya kiya', sticker: 'nazar', rot: 4, tone: 'tea', ghost: 'Log' }, // [HF-ADMIN-SWEEP-1]
'host-review': { line: 'Naye chehre, pehli nazar', sticker: 'nazar', rot: -5, tone: 'rani', ghost: 'Chehre' },
'host-intro': { line: 'Naye sitare, intro dekho', sticker: 'girlboss', rot: -4, tone: 'rani', ghost: 'Sitare' }, // [HF-INTRO-B2]
'host-kyc': { line: 'Pehchaan pakki karo', sticker: 'peace', rot: 5, tone: 'tea', ghost: 'Pehchaan' },
'host-avatars': { line: 'Chehre hazaar', sticker: 'fav', rot: -5, tone: 'lav', ghost: 'Chehre' },
'host-demo': { line: 'Dikhawe ke sitare', sticker: 'girlboss', rot: 5, tone: 'rani', ghost: 'Sitare' },
'host-reviews': { line: 'Log kya kahenge?', sticker: 'lkk', rot: -5, tone: 'lav', ghost: 'Log' },
'host-calls': { line: 'Kitni baatein hui?', sticker: 'pco', rot: 5, tone: 'saffron', ghost: 'Baatein' },
'host-payouts': { line: 'Mehnat ki kamaai', sticker: 'yaari', rot: -5, tone: 'plum', ghost: 'Kamaai' },
'host-refunds': { line: 'Paisa wapas, wallet se', sticker: 'auto', rot: 5, tone: 'tea', ghost: 'Wapas' },
'host-reconciliation': { line: 'Hisaab barabar?', sticker: 'chugli', rot: -5, tone: 'gold', ghost: 'Hisaab' },
'host-phone-costs': { line: 'Phone ka bill, paai-paai', sticker: 'panipilo', rot: 5, tone: 'tea', ghost: 'Bill' },
'merch-orders': { line: 'Kurte ka hisaab', sticker: 'swag', rot: -5, tone: 'saffron', ghost: 'Order' }, // [HF-MERCH-ADMIN-1]
'merch-products': { line: 'Naye design, pehli nazar', sticker: 'girlboss', rot: 5, tone: 'rani', ghost: 'Design' },
'merch-settings': { line: 'Merch ke niyam', sticker: 'chai', rot: -5, tone: 'lav', ghost: 'Niyam' },
'merch-wallet': { line: 'Merch ka khazana', sticker: 'fav', rot: 5, tone: 'gold', ghost: 'Khazana' },
'merch-ai': { line: 'AI ki tasveer, ek rate', sticker: 'girlboss', rot: -5, tone: 'rani', ghost: 'Tasveer' }, // [HF-MERCH-STUDIO-2]
'preview-help': { line: 'Madad ka panna', sticker: 'chai', rot: -5, tone: 'lav', ghost: 'Madad' },
'preview-legal': { line: 'Kaanoon ki kitaab', sticker: 'aalsi', rot: 5, tone: 'gold', ghost: 'Kaanoon' },
};
