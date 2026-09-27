// [MKT-V2-1 2026-09-27] Festival calendar shown on /marketplace.
//
// NOTE FOR AI / OWNER-EDITABLE CONTENT:
//  - These dates are EDITORIAL content the owner maintains by hand (2026 Hindu
//    calendar, dates as used in the owner-approved marketplace mockup). They are
//    not derived from listings. When an admin source for festivals exists, this
//    file becomes its fallback — until then, edit the list below.
//  - `start` is the IST calendar date (YYYY-MM-DD). `days` is how long the
//    festival runs (Navratri = 9). Past festivals are hidden automatically.
//  - `keyword` is what the "→" link searches for (/marketplace?q=<keyword>);
//    `aliases` are extra spellings matched in listing titles (e.g. Karwa/Karva).
//  - Event counts are computed on the page from REAL listings: a listing counts
//    when its title/deity names the festival, or when the admin set its intention
//    to "festival" and it is scheduled inside the festival's dates. Never type a
//    count here.

export interface Festival {
  /** IST date the festival begins, YYYY-MM-DD. */
  start: string;
  /** Number of days it runs (1 for a single-day festival). */
  days: number;
  name: string;
  note: string;
  /** Search term used by the "→" link. */
  keyword: string;
  /** Other spellings to match in listing titles (lower-case). */
  aliases?: string[];
}

export const FESTIVALS_2026: Festival[] = [
  { start: '2026-10-11', days: 9, name: 'Sharad Navratri begins', note: '9 nights of Durga · daily havans', keyword: 'Navratri', aliases: ['navaratri', 'navratri'] },
  { start: '2026-10-20', days: 1, name: 'Dussehra', note: 'Rama & Durga pujas', keyword: 'Dussehra', aliases: ['dussehra', 'dasara', 'vijayadashami'] },
  { start: '2026-10-29', days: 1, name: 'Karva Chauth', note: 'Evening puja for couples', keyword: 'Karva Chauth', aliases: ['karva chauth', 'karwa chauth'] },
  { start: '2026-11-08', days: 1, name: 'Diwali · Lakshmi Puja', note: 'Our biggest evening of the year', keyword: 'Diwali', aliases: ['diwali', 'deepavali'] },
  { start: '2026-11-15', days: 1, name: 'Chhath Puja', note: 'Surya arghya at dawn', keyword: 'Chhath', aliases: ['chhath'] },
];

const DAY = 86_400_000;
/** Midnight IST (UTC+05:30) of a YYYY-MM-DD date, in epoch ms. */
export function festivalStartMs(f: Festival): number {
  return Date.parse(f.start + 'T00:00:00+05:30');
}
export function festivalEndMs(f: Festival): number {
  return festivalStartMs(f) + Math.max(1, f.days) * DAY;
}
/** Festivals that have not ended yet, soonest first. */
export function upcomingFestivals(now = Date.now(), list: Festival[] = FESTIVALS_2026): Festival[] {
  return list.filter((f) => festivalEndMs(f) > now).sort((a, b) => festivalStartMs(a) - festivalStartMs(b));
}
/** Every lower-case term that names this festival. */
export function festivalTerms(f: Festival): string[] {
  return [...new Set([f.keyword.toLowerCase(), ...(f.aliases ?? [])])];
}
