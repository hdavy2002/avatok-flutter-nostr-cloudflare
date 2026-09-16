/** Public, authored UI copy only. No provider or account data is reachable here. */
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
export const RELEASE = /^[a-f0-9]{64}$/;
export const NAMESPACE = /^[a-z][a-z0-9_-]{0,63}$/;
export const LOCALES = new Set(['en', 'hi-Latn', 'as', 'bn', 'brx', 'doi', 'gu', 'hi', 'kn', 'ks', 'kok', 'mai', 'ml', 'mni', 'mr', 'ne', 'or', 'pa', 'sa', 'sat', 'sd', 'ta', 'te', 'ur', 'bho', 'awa']);
export interface UiCatalog {
  schemaVersion: 1;
  release: string;
  locale: string;
  namespace: string;
  messages: Record<string, string>;
  sourceHash: string;
}
export interface UiManifest {
  schemaVersion: 1;
  release: string;
  namespaces: string[];
  sourceHashes?: Record<string, string>;
  locales: Record<string, { namespaces: string[]; status: 'source' | 'reviewed' | 'machine' }>;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validCatalog(v: unknown, release: string, locale: string, namespace: string): v is UiCatalog {
  if (!record(v) || v.schemaVersion !== 1 || v.release !== release || v.locale !== locale || v.namespace !== namespace || typeof v.sourceHash !== 'string' || !RELEASE.test(v.sourceHash) || !record(v.messages)) return false;
  if (Object.keys(v).sort().join(',') !== 'locale,messages,namespace,release,schemaVersion,sourceHash') return false;
  return Object.keys(v.messages).length > 0 && Object.entries(v.messages).every(([k, text]) => k.length > 0 && k.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(k) && typeof text === 'string' && text.length <= 16000);
}
export function validManifest(v: unknown): v is UiManifest {
  if (!record(v) || v.schemaVersion !== 1 || typeof v.release !== 'string' || !RELEASE.test(v.release) || !Array.isArray(v.namespaces) || !record(v.locales)) return false;
  const fields = Object.keys(v).sort().join(',');
  if (fields !== 'locales,namespaces,release,schemaVersion' && fields !== 'locales,namespaces,release,schemaVersion,sourceHashes') return false;
  const namespaces = v.namespaces;
  if (!namespaces.length || !namespaces.every(n => typeof n === 'string' && NAMESPACE.test(n)) || new Set(namespaces).size !== namespaces.length) return false;
  if (v.sourceHashes !== undefined && (!record(v.sourceHashes) || Object.keys(v.sourceHashes).length !== namespaces.length || !Object.entries(v.sourceHashes).every(([ns, hash]) => namespaces.includes(ns) && typeof hash === 'string' && RELEASE.test(hash)))) return false;
  return Object.keys(v.locales).includes('en') && Object.entries(v.locales).every(([locale, info]) => LOCALES.has(locale) && record(info) && Object.keys(info).sort().join(',') === 'namespaces,status' && ['source', 'reviewed', 'machine'].includes(String(info.status)) && Array.isArray(info.namespaces) && info.namespaces.length > 0 && new Set(info.namespaces).size === info.namespaces.length && info.namespaces.every(n => namespaces.includes(n)));
}
export function catalogObjectKey(environment: string | undefined, pathname: string): string | null {
  if (environment !== 'prod' && environment !== 'staging') return null;
  if (pathname === '/i18n/v1/manifest.json') return `ui-catalogs/${environment}/v1/manifest.json`;
  const source = /^\/i18n\/v1\/sources\/([a-f0-9]{64})\/manifest\.json$/.exec(pathname);
  if (source) return `ui-catalogs/${environment}/v1/sources/${source[1]}/manifest.json`;
  const match = /^\/i18n\/v1\/([a-f0-9]{64})\/([A-Za-z-]+)\/([a-z][a-z0-9_-]{0,63})\.json$/.exec(pathname);
  if (!match || !LOCALES.has(match[2])) return null;
  return `ui-catalogs/${environment}/v1/${match[1]}/${match[2]}/${match[3]}.json`;
}
