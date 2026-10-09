/* [HF-HOST-ONBOARD-1] 32x32 stroke icons, same style as ModernIcon.astro / DetailIcon.astro. */
export type IconName = 'user'|'clock'|'globe'|'sparkle'|'play'|'pause'|'phone'|'bell'|'chat'|'shield'|'lock'|'mic'|'stop'|'check'|'arrowLeft'|'x'|'upload'|'star'|'heart'|'calendar'|'video'|'id'|'image'|'rupee';

const PATHS: Record<IconName, string> = {
  user: 'M16 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12M5 29v-4a11 11 0 0 1 22 0v4',
  clock: 'M16 3a13 13 0 1 0 0 26 13 13 0 0 0 0-26M16 8v9l6 3',
  globe: 'M16 3a13 13 0 1 0 0 26 13 13 0 0 0 0-26M3 16h26M16 3c-8 7-8 19 0 26 8-7 8-19 0-26',
  sparkle: 'M16 3l4 9 9 4-9 4-4 9-4-9-9-4 9-4z',
  play: 'M11 6l15 10-15 10z',
  pause: 'M10 6v20M22 6v20',
  phone: 'M10 3H6C2 14 18 30 29 26v-4l-7-4-4 4-8-8 4-4-4-7',
  bell: 'M7 13a9 9 0 0 1 18 0v8l3 4H4l3-4v-8M12 29h8',
  chat: 'M27 16a11 11 0 1 0-6 10l7 3-2-8a11 11 0 0 0 1-5',
  shield: 'M16 3 28 8v9c0 6-8 11-12 13C12 28 4 23 4 17V8L16 3M10 16l4 4 8-9',
  lock: 'M8 14h16v15H8zM11 14V9a5 5 0 0 1 10 0v5M16 20v4',
  mic: 'M16 3a5 5 0 0 0-5 5v8a5 5 0 0 0 10 0V8a5 5 0 0 0-5-5M7 15a9 9 0 0 0 18 0M16 24v5M11 29h10',
  stop: 'M8 8h16v16H8z',
  check: 'M5 17l7 7 15-16',
  arrowLeft: 'M27 16H5m9-9L5 16l9 9',
  x: 'M7 7l18 18M25 7L7 25',
  upload: 'M16 21V5m-7 7 7-7 7 7M5 21v7h22v-7',
  star: 'M16 3l4 9 10 1-7.5 6.5L25 29l-9-5-9 5 2.5-9.5L2 13l10-1z',
  heart: 'M16 28C5 20 3 14 3 10a6 6 0 0 1 13-2 6 6 0 0 1 13 2c0 4-2 10-13 18',
  calendar: 'M5 7h22v22H5zM5 13h22M10 3v8M22 3v8',
  video: 'M3 8h18v16H3zM21 14l8-5v14l-8-5',
  id: 'M3 6h26v20H3zM8 13h7M8 18h5M20 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6M16 22a5 5 0 0 1 8 0',
  image: 'M3 5h26v22H3zM3 22l8-8 6 6 4-4 8 8M21 11h.1',
  rupee: 'M9 6h15M9 12h15M9 6c10 0 10 12 0 12l10 9',
};

export default function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg className="hob-icon" viewBox="0 0 32 32" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
