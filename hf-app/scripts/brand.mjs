// Reads the brand from Specs/brand.json (single source of truth). Nothing in hf-app/ types the
// brand name or domain: every build step asks this file.
//
//   node scripts/brand.mjs print     show the values the build will use
//   node scripts/brand.mjs offline   fill the brand name and site URL into the offline page copy that
//                                    `cap sync` put inside the Android assets
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(here, '..');
export const BRAND_JSON = resolve(APP_ROOT, '..', 'Specs', 'brand.json');

export function loadBrand() {
  const b = JSON.parse(readFileSync(BRAND_JSON, 'utf8'));
  for (const k of ['name', 'domain', 'hfPlayPackageId']) {
    if (!b[k]) throw new Error(`Specs/brand.json is missing "${k}"`);
  }
  for (const k of ['api', 'auth', 'media']) {
    if (!b.hosts?.[k]) throw new Error(`Specs/brand.json is missing hosts.${k}`);
  }
  return {
    name: b.name,
    domain: b.domain,
    hosts: b.hosts,
    appId: b.hfPlayPackageId,
    scheme: b.domain.split('.')[0],
  };
}

// Same file location Capacitor copies www/ to.
export const OFFLINE_IN_ASSETS = resolve(APP_ROOT, 'android/app/src/main/assets/public/offline.html');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] || 'print';
  const brand = loadBrand();
  if (cmd === 'print') {
    console.log(JSON.stringify(brand, null, 2));
  } else if (cmd === 'offline') {
    if (!existsSync(OFFLINE_IN_ASSETS)) {
      console.error('offline.html not found in android assets; run `npx cap sync android` first');
      process.exit(1);
    }
    const html = readFileSync(OFFLINE_IN_ASSETS, 'utf8').replaceAll('__BRAND_NAME__', brand.name)
      .replaceAll('__SITE_URL__', `https://${brand.domain}`);
    writeFileSync(OFFLINE_IN_ASSETS, html);
    console.log('offline.html branded');
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
}
