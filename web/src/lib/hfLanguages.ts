// [HF-DAILY-FLOWS-1] Influencer languages are stored as short codes ("en", "hi") by the app and as names ("Hindi") by older saves.
// Every place that SHOWS a language (public profile, Explore cards) goes through langLabel so a caller never reads "en, hi".
// Mirror of worker/src/lib/hf_options.ts LANGUAGE_CODES.
export const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  hi: 'Hindi', en: 'English', mr: 'Marathi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', kn: 'Kannada', ml: 'Malayalam',
  gu: 'Gujarati', pa: 'Punjabi', or: 'Odia', bho: 'Bhojpuri', gbm: 'Garhwali', kfy: 'Kumaoni', ur: 'Urdu', as: 'Assamese',
};

/** "hi" -> "Hindi"; a name that is already a name stays; anything unknown is shown as written (title-cased). */
export function langLabel(v: string): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const byCode = LANGUAGE_NAMES[s.toLowerCase()];
  if (byCode) return byCode;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const langLabels = (list: readonly string[] | null | undefined): string[] =>
  [...new Set((list ?? []).map(langLabel).filter(Boolean))];
