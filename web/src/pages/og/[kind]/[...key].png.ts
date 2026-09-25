import type { APIRoute } from 'astro';
import { resolveOgRecord } from '../../../lib/seo/resolve';
import { ogResponse } from '../../../lib/seo/og/response';

export const prerender = false;

export const GET: APIRoute = ({ request, params }) =>
  ogResponse(request, params.kind ?? '', params.key ?? '', resolveOgRecord);

export const HEAD: APIRoute = GET;
