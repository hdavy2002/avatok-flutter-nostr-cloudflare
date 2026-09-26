import { assetRevision, fontRevision } from './assets.generated';
import type { OgRecord } from './types';

// Bump when layout, sanitization or rendering behavior changes.
// saathum-og-2: [SEO-OG-ART-1] per-article/listing artwork actually renders; new
// URLs force WhatsApp/Facebook to drop the cached brand-hero cards.
// saathum-og-3: [OG-AD-HOOK-1] ad layout (hook + price pill) for articles/listings.
export const TEMPLATE_REVISION = 'saathum-og-3';
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
    record.ad?.hook ?? '', record.ad?.price ?? '',
  ]));
}

export async function ogImagePath(record: OgRecord): Promise<string> {
  const key = record.key.split('/').map(encodeURIComponent).join('/');
  return `/og/${record.kind}/${key}.png?v=${await ogRevision(record)}`;
}
