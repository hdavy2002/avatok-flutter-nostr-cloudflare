// [HF-APP-LINKS-1] Post-build contract: Android App Links need /.well-known/assetlinks.json served as a
// STATIC file (200, application/json, no redirect) listing the app package. Two ways it silently broke:
//   1. the file is missing/empty in dist, or does not list the package;
//   2. dist/_routes.json does not exclude /.well-known/*, so the request reaches the SSR Function and the
//      [username]/[slug] route answers 404 "Not found" (what hellofraands.com did until this check).
// Package id comes from Specs/brand.json (hfPlayPackageId) - never typed here.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BRAND } from './brand.mjs';

const pkg = JSON.parse(readFileSync(new URL('../../Specs/brand.json', import.meta.url), 'utf8')).hfPlayPackageId;
const errors = [];
const file = resolve('dist/.well-known/assetlinks.json');
if (!pkg) errors.push('Specs/brand.json has no hfPlayPackageId');
if (!existsSync(file)) {
  errors.push('dist/.well-known/assetlinks.json is missing (web/public/.well-known/assetlinks.json not copied)');
} else {
  try {
    const list = JSON.parse(readFileSync(file, 'utf8'));
    const entry = Array.isArray(list) ? list.find((e) => e?.target?.package_name === pkg) : null;
    if (!entry) errors.push(`assetlinks.json does not list ${pkg}`);
    else {
      if (!entry.relation?.includes('delegate_permission/common.handle_all_urls')) errors.push(`${pkg} entry lacks delegate_permission/common.handle_all_urls`);
      const fps = entry.target?.sha256_cert_fingerprints ?? [];
      if (!fps.length || !fps.every((f) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f))) errors.push(`${pkg} entry has missing or malformed sha256_cert_fingerprints`);
    }
  } catch (e) {
    errors.push(`assetlinks.json is not valid JSON: ${e.message}`);
  }
}
const routesFile = resolve('dist/_routes.json');
if (existsSync(routesFile)) {
  const routes = JSON.parse(readFileSync(routesFile, 'utf8'));
  const excluded = routes.exclude?.includes('/.well-known/*') || routes.exclude?.includes('/.well-known/assetlinks.json');
  if (!excluded) errors.push('dist/_routes.json does not exclude /.well-known/* (the SSR Function would answer 404)');
}
if (errors.length) {
  for (const e of errors) console.error(`check-assetlinks FAILED: ${e}`);
  process.exit(1);
}
console.log(`check-assetlinks: ${BRAND.webOrigin}/.well-known/assetlinks.json lists ${pkg}; _routes.json keeps /.well-known/* static`);
