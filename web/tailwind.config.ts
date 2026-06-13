import type { Config } from 'tailwindcss';
// GENERATED, do-not-edit fragment produced by scripts/export-zine-tokens.mjs
// from ../app/lib/core/ui/zine.dart. This is the ONLY source of zine theme
// values — never hardcode a hex/radius/shadow in a component.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const zine = require('./tailwind.zine.cjs');

export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx,md,mdx}'],
  theme: {
    extend: zine,
  },
  plugins: [],
} satisfies Config;
