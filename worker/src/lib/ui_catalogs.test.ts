import { describe, it, expect } from 'vitest';
// This spec sits beside the source it covers, so `tsc --project worker/tsconfig.json`
// checks it with the Worker lib set (`types: ["@cloudflare/workers-types"]`, no node
// types). Under vitest both `node:fs` and `import.meta.url` are real; the compiler
// simply cannot see them, and widening the Worker's type surface to prove a test
// right would let production code import node built-ins too.
// @ts-expect-error node:fs is provided by the vitest runtime, not by workers-types
import { readFileSync } from 'node:fs';
import { catalogObjectKey, validManifest, validCatalog, LOCALES } from './ui_catalogs';
const release = 'a'.repeat(64);
describe('UI catalog public boundary', () => {
  it('keeps the public route and catalog schema aligned with the shared Indian registry', () => {
    const here = (import.meta as ImportMeta & { url: string }).url;
    const registry = JSON.parse(readFileSync(new URL('../../../shared/i18n/locales.json', here), 'utf8')) as Array<{ code: string }>;
    const schema = JSON.parse(readFileSync(new URL('../../../shared/i18n/catalog.schema.json', here), 'utf8'));
    const codes = registry.map(item => item.code).sort();
    expect([...LOCALES].sort()).toEqual(codes);
    expect([...schema.properties.locale.enum].sort()).toEqual(codes);
    for (const code of ['bho', 'awa']) {
      expect(catalogObjectKey('prod', `/i18n/v1/${release}/${code}/common.json`)).toBe(`ui-catalogs/prod/v1/${release}/${code}/common.json`);
    }
    expect(LOCALES.has('ar')).toBe(false);
  });
  it('isolates environment and rejects traversal/unsupported locales', () => {
    expect(catalogObjectKey('prod', `/i18n/v1/${release}/hi/common.json`)).toBe(`ui-catalogs/prod/v1/${release}/hi/common.json`);
    expect(catalogObjectKey('staging', `/i18n/v1/${release}/hi/common.json`)).not.toEqual(catalogObjectKey('prod', `/i18n/v1/${release}/hi/common.json`));
    expect(catalogObjectKey('prod', `/i18n/v1/sources/${release}/manifest.json`)).toBe(`ui-catalogs/prod/v1/sources/${release}/manifest.json`);
    expect(catalogObjectKey('prod', '/i18n/v1/sources/not-a-hash/manifest.json')).toBeNull();
    expect(catalogObjectKey(undefined, '/i18n/v1/manifest.json')).toBeNull();
    expect(catalogObjectKey('prod', `/i18n/v1/${release}/ar/common.json`)).toBeNull();
    expect(catalogObjectKey('prod', `/i18n/v1/${release}/hi/../private.json`)).toBeNull();
  });
  it('rejects stale or malformed envelopes and unavailable namespace manifests', () => {
    const catalog = { schemaVersion: 1, release, locale: 'hi', namespace: 'common', messages: { title: 'नमस्ते' }, sourceHash: release };
    expect(validCatalog(catalog, release, 'hi', 'common')).toBe(true);
    expect(validCatalog(catalog, 'b'.repeat(64), 'hi', 'common')).toBe(false);
    expect(validCatalog({ ...catalog, messages: { title: 3 } }, release, 'hi', 'common')).toBe(false);
    expect(validManifest({ schemaVersion: 1, release, namespaces: ['common'], locales: { en: { namespaces: ['private'], status: 'source' } } })).toBe(false);
  });
});
