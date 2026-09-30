// [WEB-PERF-1 2026-09-30] check-image-urls / check-image-coverage evaluate
// src/lib/config.ts as a standalone data: module, which cannot resolve relative
// imports. config.ts now re-exports its plain values from ./env (which reads
// ./brand), so this inlines both before the caller transpiles the result.
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../src/lib/' + rel, import.meta.url), 'utf8');

/** config.ts source with ./env and ./brand inlined; manifest import left for the caller. */
export function configSource() {
  const brand = read('brand.ts');
  const env = read('env.ts').replace("import { BRAND } from './brand';", brand);
  return read('config.ts')
    .replace(/^export \{[^}]*\} from '\.\/env';\n/m, '')
    .replace(/^import \{[^}]*\} from '\.\/env';\n/m, env + '\n');
}
