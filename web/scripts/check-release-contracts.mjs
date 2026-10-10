// Run every independent post-build release contract and report all failures.
// Individual scripts remain directly runnable; this is the production gate.
import { spawnSync } from 'node:child_process';

const checks = [
  ['homepage and archive', 'check-homepage.mjs'],
  ['sample profile details', 'check-profile-details.mjs'],
  ['help centre', 'check-help.mjs'],
  ['public SEO', 'check-seo.mjs'],
  ['Open Graph runtime', 'check-og-runtime.mjs'],
  ['public image URLs', 'check-image-urls.mjs'],
  ['render performance', 'check-render-performance.mjs'],
  ['data performance', 'check-data-performance.mjs'],
  ['image coverage', 'check-image-coverage.mjs'],
  ['brand leaks', 'check-brand-leaks.mjs'],
  ['App Links assetlinks', 'check-assetlinks.mjs'],
];

const failures = [];
for (const [label, script] of checks) {
  console.log(`::group::Release contract — ${label}`);
  const result = spawnSync(process.execPath, [`scripts/${script}`], {
    cwd: process.cwd(),
    env: { ...process.env, CI_CONTRACT_AGGREGATE: '1' },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  console.log('::endgroup::');
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || `exit ${result.status ?? 'unknown'}`;
    failures.push({ label, script, reason });
    console.error(`::error title=Release contract failed::${label} (${script}): ${reason}`);
  }
}

if (failures.length) {
  console.error('\nRelease contract failures:');
  for (const failure of failures) console.error(`- ${failure.label}: ${failure.script} (${failure.reason})`);
  process.exitCode = 1;
} else {
  console.log(`All ${checks.length} independent release contracts passed.`);
}
