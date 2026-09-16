// Run only in the manually dispatched web CI build, before publication.
import { execFileSync } from 'node:child_process';
for (const script of ['check-render-performance.mjs', 'check-data-performance.mjs', 'check-image-coverage.mjs']) {
  execFileSync(process.execPath, [`scripts/${script}`], { stdio: 'inherit' });
}
console.log('Web performance release checks passed');
