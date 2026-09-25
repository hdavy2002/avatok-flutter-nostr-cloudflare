import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';
// GENERATED, do-not-edit fragment produced by scripts/export-zine-tokens.mjs
// from ../app/lib/core/ui/zine.dart. This is the ONLY source of zine theme
// values — never hardcode a hex/radius/shadow in a component.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const zine = require('./tailwind.zine.cjs');

// [DASH2-FOUNDATION 2026-09-25] shadcn/ui theme keys for Dashboard 2, merged ON
// TOP of the generated zine extend without changing anything the rest of the
// site renders:
//  - Every shadcn colour reads an HSL triplet CSS variable that is defined ONLY
//    under `.dash2` (src/styles/saathum-tokens.css). Outside `.dash2` no element
//    uses these utilities, so nothing changes.
//  - `card` is the one key that collides with zine (`bg-card` = var(--zine-card)
//    all over the v1 dashboard). Its DEFAULT stays var(--zine-card); `.dash2`
//    re-points --zine-card at the shadcn card colour, so `bg-card` means the
//    right thing in both worlds. Only `card.foreground` is new.
//  - borderRadius lg/md/sm fall back to Tailwind's own defaults (8px/6px/2px)
//    when --radius is unset, i.e. everywhere outside `.dash2`.
const hsl = (v: string) => `hsl(var(--${v}) / <alpha-value>)`;
const shadcnColors = {
  border: hsl('border'),
  input: hsl('input'),
  ring: hsl('ring'),
  background: hsl('background'),
  foreground: hsl('foreground'),
  primary: { DEFAULT: hsl('primary'), foreground: hsl('primary-foreground') },
  secondary: { DEFAULT: hsl('secondary'), foreground: hsl('secondary-foreground') },
  destructive: { DEFAULT: hsl('destructive'), foreground: hsl('destructive-foreground') },
  muted: { DEFAULT: hsl('muted'), foreground: hsl('muted-foreground') },
  accent: { DEFAULT: hsl('accent'), foreground: hsl('accent-foreground') },
  popover: { DEFAULT: hsl('popover'), foreground: hsl('popover-foreground') },
  scrim: hsl('scrim'),
  card: { DEFAULT: zine.colors.card, foreground: hsl('card-foreground') },
  // Named landing tokens, for dashboard chrome (gold rules, teal marker...).
  grand: {
    cream: 'var(--grand-cream)',
    teal: 'var(--grand-teal)',
    ink: 'var(--grand-ink)',
    red: 'var(--grand-red)',
    sage: 'var(--grand-sage)',
    gold: 'var(--grand-gold)',
  },
};

export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx,md,mdx}'],
  theme: {
    extend: {
      ...zine,
      colors: { ...zine.colors, ...shadcnColors },
      borderRadius: {
        ...zine.borderRadius,
        lg: 'var(--radius, 0.5rem)',
        md: 'calc(var(--radius, 0.5rem) - 2px)',
        sm: 'calc(var(--radius, 0.375rem) - 4px)',
      },
      fontFamily: {
        ...zine.fontFamily,
        // Dashboard 2 only: Comfortaa headings, Nunito body.
        dash: ['Comfortaa', '"Baloo 2"', 'system-ui', 'sans-serif'],
        dashbody: ['Nunito', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-collapsible-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-collapsible-content-height)' }, to: { height: '0' } },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [animate],
} satisfies Config;
