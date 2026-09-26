import type { APIRoute } from 'astro';
import { resolveOgRecord } from '../../../lib/seo/resolve';
import { ogResponse } from '../../../lib/seo/og/response';
import type { AssetFetcher } from '../../../lib/seo/og/public-art';

// [SEO-OG-ART-1] Pages exposes static files as env.ASSETS; the renderer reads
// the page's own artwork from there instead of a self-fetch over the network.
type RuntimeLocals = { runtime?: { env?: { ASSETS?: AssetFetcher } } };

export const prerender = false;

export const GET: APIRoute = ({ request, params, locals }) =>
  ogResponse(request, params.kind ?? '', params.key ?? '', resolveOgRecord,
    (locals as unknown as RuntimeLocals).runtime?.env?.ASSETS);

export const HEAD: APIRoute = GET;
