import { assetRevision, fontRevision } from './assets.generated';
import type { OgRecord } from './types';

// Bump when layout, sanitization or rendering behavior changes.
export const TEMPLATE_REVISION = 'saathum-og-1';
export const RENDERER_REVISION = 'cf-workers-og-3.0.1';

export async function sha256(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Revision fields plus displayed copy prevent stale URLs when an editor forgets a revision. */
export function ogRevision(record: OgRecord): Promise<string> {
  return sha256(JSON.stringify([
    TEMPLATE_REVISION, RENDERER_REVISION, fontRevision, assetRevision,
    record.kind, record.key, record.title, record.description ?? '', record.canonicalPath,
    record.contentRevision, record.art?.url ?? '', record.art?.revision ?? '',
  ]));
}

export async function ogImagePath(record: OgRecord): Promise<string> {
  const key = record.key.split('/').map(encodeURIComponent).join('/');
  return `/og/${record.kind}/${key}.png?v=${await ogRevision(record)}`;
}
