/* [WA-WEB-1 2026-09-28] Static country list for the WhatsApp number input —
 * country picker + dial code + flag emoji, no new npm dependency. Not
 * exhaustive (195 countries), but covers the countries Saathum's audience and
 * international WhatsApp users are realistically dialling from. India is the
 * default (owner decision).
 */
export interface Country {
  code: string; // ISO 3166-1 alpha-2
  name: string;
  dial: string; // no leading '+'
  flag: string; // emoji, built from the ISO code
}

function flagOf(code: string): string {
  return code
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

const RAW: [string, string, string][] = [
  ['IN', 'India', '91'],
  ['US', 'United States', '1'],
  ['CA', 'Canada', '1'],
  ['GB', 'United Kingdom', '44'],
  ['AU', 'Australia', '61'],
  ['NZ', 'New Zealand', '64'],
  ['AE', 'United Arab Emirates', '971'],
  ['SA', 'Saudi Arabia', '966'],
  ['QA', 'Qatar', '974'],
  ['KW', 'Kuwait', '965'],
  ['BH', 'Bahrain', '973'],
  ['OM', 'Oman', '968'],
  ['SG', 'Singapore', '65'],
  ['MY', 'Malaysia', '60'],
  ['TH', 'Thailand', '66'],
  ['ID', 'Indonesia', '62'],
  ['PH', 'Philippines', '63'],
  ['VN', 'Vietnam', '84'],
  ['JP', 'Japan', '81'],
  ['KR', 'South Korea', '82'],
  ['CN', 'China', '86'],
  ['HK', 'Hong Kong', '852'],
  ['TW', 'Taiwan', '886'],
  ['NP', 'Nepal', '977'],
  ['BD', 'Bangladesh', '880'],
  ['LK', 'Sri Lanka', '94'],
  ['PK', 'Pakistan', '92'],
  ['MM', 'Myanmar', '95'],
  ['DE', 'Germany', '49'],
  ['FR', 'France', '33'],
  ['ES', 'Spain', '34'],
  ['IT', 'Italy', '39'],
  ['NL', 'Netherlands', '31'],
  ['BE', 'Belgium', '32'],
  ['CH', 'Switzerland', '41'],
  ['AT', 'Austria', '43'],
  ['SE', 'Sweden', '46'],
  ['NO', 'Norway', '47'],
  ['DK', 'Denmark', '45'],
  ['FI', 'Finland', '358'],
  ['IE', 'Ireland', '353'],
  ['PT', 'Portugal', '351'],
  ['PL', 'Poland', '48'],
  ['RU', 'Russia', '7'],
  ['TR', 'Turkey', '90'],
  ['GR', 'Greece', '30'],
  ['ZA', 'South Africa', '27'],
  ['NG', 'Nigeria', '234'],
  ['KE', 'Kenya', '254'],
  ['EG', 'Egypt', '20'],
  ['MU', 'Mauritius', '230'],
  ['BR', 'Brazil', '55'],
  ['MX', 'Mexico', '52'],
  ['AR', 'Argentina', '54'],
  ['CO', 'Colombia', '57'],
  ['FJ', 'Fiji', '679'],
  ['TT', 'Trinidad and Tobago', '1868'],
  ['GY', 'Guyana', '592'],
  ['SR', 'Suriname', '597'],
];

export const COUNTRIES: Country[] = RAW.map(([code, name, dial]) => ({ code, name, dial, flag: flagOf(code) }));

export const DEFAULT_COUNTRY: Country = COUNTRIES.find((c) => c.code === 'IN')!;

export function findCountry(code: string | null | undefined): Country {
  return COUNTRIES.find((c) => c.code === code) ?? DEFAULT_COUNTRY;
}

/** Country + national digits -> E.164 ("+<dial><digits>"). */
export function toE164(countryCode: string, nationalDigits: string): string {
  const c = findCountry(countryCode);
  const digits = nationalDigits.replace(/\D/g, '');
  return `+${c.dial}${digits}`;
}
