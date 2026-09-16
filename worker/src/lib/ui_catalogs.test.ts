import { describe, it, expect, vi } from 'vitest';
import { catalogObjectKey, validManifest, validCatalog, LOCALES } from './ui_catalogs';
const release = 'a'.repeat(64);
describe('UI catalog public boundary', () => {
  it('keeps the public route and catalog schema aligned with the shared Indian registry', async () => {
    // Let Vitest load the actual JSON; keep Node-only APIs out of Worker types.
    const { default: registry } = await vi.importActual<{ default: Array<{ code: string }> }>('../../../shared/i18n/locales.json');
    const { default: schema } = await vi.importActual<{ default: { properties: { locale: { enum: string[] } } } }>('../../../shared/i18n/catalog.schema.json');
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
