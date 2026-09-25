// [SAATHUM-GUIDE-2 2026-09-25] Runs after `astro build` (npm "postbuild").
// astro.config.mjs adds wildcard excludes (/rituals/*, /blog/creator-ideas/*) so
// prerendered pages stay under Cloudflare's 100-rule _routes.json ceiling. But
// Astro still writes the individual page rules too, and Cloudflare REJECTS any
// file where a splat rule overlaps another rule ("Overlapping rules found") —
// the deploy fails at upload. This drops every rule already covered by a splat.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve('dist', '_routes.json');
if (!existsSync(file)) process.exit(0);
const routes = JSON.parse(readFileSync(file, 'utf8'));
const dedupe = (rules) => {
  const splats = rules.filter(rule => rule.endsWith('/*')).map(rule => rule.slice(0, -1));
  const covered = (rule) => splats.some(prefix => rule !== prefix + '*' && (rule.startsWith(prefix) || rule + '/' === prefix));
  return [...new Set(rules)].filter(rule => !covered(rule));
};
const before = routes.include.length + routes.exclude.length;
routes.include = dedupe(routes.include);
routes.exclude = dedupe(routes.exclude);
const after = routes.include.length + routes.exclude.length;
if (after > 100) throw new Error(`_routes.json has ${after} rules; Cloudflare allows 100`);
writeFileSync(file, JSON.stringify(routes, null, 2) + '\n');
console.log(`_routes.json: ${before} → ${after} rules (splat-covered duplicates removed)`);
