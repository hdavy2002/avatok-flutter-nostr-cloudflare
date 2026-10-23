/* [HF-MERCH-STUDIO-2] The 16 print fonts of the merch studio (Specs/SPEC-2026-10-23-HF-MERCH-STUDIO-2.md section 4).
 * Static OFL / Apache TTFs in /public/fonts/merch. Loaded lazily (never blocks first paint): the studio asks for the fonts it needs. */
export interface MerchFont {
  family: string; file: string; label: string; devanagari: boolean; sample: string;
  /** Real bold / italic faces. All the files are single-weight, so both are false and the toggles stay hidden. */
  bold: boolean; italic: boolean;
}

const HI = 'नमस्ते दोस्तों';
const mk = (family: string, file: string, label: string, devanagari: boolean, sample?: string): MerchFont =>
  ({ family, file, label, devanagari, sample: sample ?? (devanagari ? HI : label), bold: false, italic: false });

export const MERCH_FONTS: MerchFont[] = [
  mk('Yatra One', 'YatraOne-Regular.ttf', 'Yatra One', true),
  mk('Rozha One', 'RozhaOne-Regular.ttf', 'Rozha One', true),
  mk('Kalam', 'Kalam-Bold.ttf', 'Kalam', true),
  mk('Khand', 'Khand-Bold.ttf', 'Khand', true),
  mk('Mukta', 'Mukta-ExtraBold.ttf', 'Mukta', true),
  mk('Tiro Devanagari Hindi', 'TiroDevanagariHindi-Regular.ttf', 'Tiro Devanagari', true),
  mk('Sahitya', 'Sahitya-Bold.ttf', 'Sahitya', true),
  mk('Poppins', 'Poppins-ExtraBold.ttf', 'Poppins', true),
  mk('Anton', 'Anton-Regular.ttf', 'Anton', false),
  mk('Bebas Neue', 'BebasNeue-Regular.ttf', 'Bebas Neue', false),
  mk('Pacifico', 'Pacifico-Regular.ttf', 'Pacifico', false),
  mk('Permanent Marker', 'PermanentMarker-Regular.ttf', 'Permanent Marker', false),
  mk('Lobster', 'Lobster-Regular.ttf', 'Lobster', false),
  mk('Abril Fatface', 'AbrilFatface-Regular.ttf', 'Abril Fatface', false),
  mk('Righteous', 'Righteous-Regular.ttf', 'Righteous', false),
  mk('Bangers', 'Bangers-Regular.ttf', 'Bangers', false),
];

export const DEFAULT_FONT = 'Yatra One';
export const fontOf = (family: string): MerchFont => MERCH_FONTS.find(f => f.family === family) ?? MERCH_FONTS[0];

const loading = new Map<string, Promise<void>>();
const done = new Set<string>();
export const isFontLoaded = (family: string): boolean => done.has(family);

/** Loads one font (cached; a failed load can be retried). Rejects when the file cannot be fetched. */
export function loadMerchFont(family: string): Promise<void> {
  const font = MERCH_FONTS.find(f => f.family === family);
  if (!font) return Promise.resolve();
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return Promise.resolve();
  let p = loading.get(family);
  if (!p) {
    p = (async () => {
      const ff = new FontFace(font.family, `url(/fonts/merch/${font.file})`, { display: 'swap' });
      await ff.load();
      document.fonts.add(ff);
      done.add(family);
    })();
    p.catch(() => { loading.delete(family); });
    loading.set(family, p);
  }
  return p;
}

/** Loads several fonts; resolves with the families that failed (the caller reports them, the studio keeps working with the fallback font). */
export async function loadMerchFonts(families: string[]): Promise<{ family: string; error: unknown }[]> {
  const uniq = [...new Set(families)];
  const res = await Promise.allSettled(uniq.map(loadMerchFont));
  const failed: { family: string; error: unknown }[] = [];
  res.forEach((r, i) => { if (r.status === 'rejected') failed.push({ family: uniq[i], error: r.reason }); });
  return failed;
}
