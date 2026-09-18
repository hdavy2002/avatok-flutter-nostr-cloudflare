import { afterEach, describe, expect, it, vi } from 'vitest';
import { uiLocalization } from './ui_localization';
import type { Env } from '../types';
const release = 'a'.repeat(64);
const envelope = { schemaVersion: 1, release, locale: 'hi', namespace: 'common', sourceHash: release, messages: { title: 'नमस्ते' } };
afterEach(() => vi.unstubAllGlobals());
describe('catalog HTTP caching', () => {
  it('returns immutable public UI only, then serves edge cache and conditional HEAD', async () => {
    const cache = new Map<string, Response>();
    vi.stubGlobal('caches', { default: { match: async (key: Request) => cache.get(key.url)?.clone(), put: async (key: Request, response: Response) => { cache.set(key.url, response); } } });
    const get = vi.fn(async () => ({ size: 400, text: async () => JSON.stringify(envelope), httpEtag: '"catalog"' }));
    const env = { ENVIRONMENT_NAME: 'prod', BLOBS: { get } } as unknown as Env;
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
    const url = `https://api.avatok.ai/i18n/v1/${release}/hi/common.json`;
    const first = await uiLocalization(new Request(url, { headers: { Cookie: 'private=secret', Authorization: 'Bearer private' } }), env, ctx);
    expect(first.headers.get('Cache-Control')).toContain('immutable');
    expect(first.headers.has('Set-Cookie')).toBe(false);
    expect(first.headers.get('Access-Control-Allow-Origin')).toBe('*');
    await Promise.all(pending);
    const second = await uiLocalization(new Request(url + '?ignore=1', { method: 'HEAD', headers: { 'If-None-Match': '"catalog"' } }), env, ctx);
    expect(second.status).toBe(304); expect(get).toHaveBeenCalledTimes(1);
    expect([...cache.keys()][0]).toContain('__catalog_environment=prod');
  });
  it('missing catalog is no-store and cannot invoke paid generation', async () => {
    vi.stubGlobal('caches', { default: { match: async () => undefined } });
    const env = { ENVIRONMENT_NAME: 'prod', BLOBS: { get: async () => null } } as unknown as Env;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const response = await uiLocalization(new Request('https://api.avatok.ai/i18n/v1/manifest.json'), env, ctx);
    expect(response.status).toBe(404); expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('old app source hashes discover a matching release with short TTL and reject bad pointers', async () => {
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => undefined } });
    const source = 'b'.repeat(64);
    const manifest = { schemaVersion: 1, release, namespaces: ['app'], sourceHashes: { app: source }, locales: { en: { namespaces: ['app'], status: 'source' } } };
    const env = { ENVIRONMENT_NAME: 'prod', BLOBS: { get: async () => ({ size: 500, httpEtag: '"pointer"', text: async () => JSON.stringify(manifest) }) } } as unknown as Env;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const response = await uiLocalization(new Request(`https://api.avatok.ai/i18n/v1/sources/${source}/manifest.json`), env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, must-revalidate');
    expect((await response.json() as { sourceHashes: { app: string } }).sourceHashes.app).toBe(source);
    const mismatch = await uiLocalization(new Request(`https://api.avatok.ai/i18n/v1/sources/${'c'.repeat(64)}/manifest.json`), env, ctx);
    expect(mismatch.status).toBe(502);
    expect(mismatch.headers.get('Cache-Control')).toBe('no-store');
  });

});
