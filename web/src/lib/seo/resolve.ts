import { ORG } from '../org';
import { ApiError, getCreator, getListing } from '../apiClient';
import { creatorOg, listingOg } from '../og';
import { ritualBySlug } from '../ritualGuides';
import { ritualAd } from '../ritualAdHooks';
import { fetchPricing } from '../pricing';
import { getHelpEntries, helpUrl, SECTIONS, type HelpSectionId } from '../help';
import { plainText, stableRevision, truncateAtWord } from './normalize';
import { buildSeoGraph } from './schema';
import { canonicalUrl, resolveRoutePolicy } from './policy';
import { listingContent, creatorContent } from './sources';
import { HELP_SEO, MARKETPLACE_SEO } from './catalog';
import { ogImagePath } from './og/revision';
import { publicArtRevision } from './og/public-art';
import type { OgRecord, OgResolveResult } from './og/types';
import type { LegacySeoInput, PublicContent, ResolvedSeo } from './types';

const DEFAULT_DESCRIPTION = ORG.description;

function brandTitle(title: string): string {
  const clean = plainText(title) || ORG.name;
  return new RegExp(ORG.name, 'i').test(clean) ? clean : `${clean} · ${ORG.name}`;
}

function ogKey(content: PublicContent): string | null {
  if (content.kind === 'home') return 'home';
  const key = content.key.replace(/^\/+|\/+$/g, '');
  return key && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(key) && !key.split('/').includes('.') && !key.split('/').includes('..')
    ? key : null;
}

function ogRecordFor(content: PublicContent, title?: string, description?: string): OgRecord | null {
  const key = ogKey(content);
  if (!key) return null;
  const resolvedTitle = brandTitle(title ?? content.title);
  const resolvedDescription = truncateAtWord(description ?? content.summary ?? content.plainText ?? DEFAULT_DESCRIPTION);
  return {
    kind: content.kind,
    key,
    title: resolvedTitle,
    description: resolvedDescription,
    canonicalPath: content.canonicalPath,
    contentRevision: stableRevision([
      content.kind, key, resolvedTitle, resolvedDescription, content.modifiedAt,
      content.publishedAt, content.image?.revision, 'seo-og-v1',
      // [PRICING-1] ad.price deliberately NOT in the revision: prices change in the
      // backend without a rebuild, and the static page's og:image URL must still match.
      content.ad?.hook,
    ]),
    art: content.image ? {
      url: content.image.url,
      revision: [content.image.revision, publicArtRevision(content.image.url)].filter(Boolean).join(':'),
      alt: content.image.alt,
    } : undefined,
    ad: content.ad?.hook ? { hook: content.ad.hook, ...(content.ad.price ? { price: content.ad.price } : {}) } : undefined,
  };
}

export async function resolveSeo(args: {
  pathname: string;
  searchParams?: URLSearchParams;
  content?: PublicContent;
  legacy?: LegacySeoInput;
}): Promise<ResolvedSeo> {
  const { pathname, searchParams, content, legacy = {} } = args;
  const policy = resolveRoutePolicy(pathname, content, searchParams);
  const title = brandTitle(content?.title ?? legacy.title ?? ORG.name);
  const description = truncateAtWord(content?.summary ?? content?.plainText ?? legacy.description ?? DEFAULT_DESCRIPTION);
  const canonical = canonicalUrl(policy.canonicalPath);
  const revision = stableRevision([
    content?.key, content?.modifiedAt, content?.image?.revision, title, description, 'seo-v1',
  ]);
  const record = content && policy.indexable ? ogRecordFor(content, title, description) : null;
  const measuredLegacyImage = legacy.image && legacy.imageWidth && legacy.imageHeight ? legacy.image : undefined;
  const sourceImage = record ? await ogImagePath(record) : measuredLegacyImage ?? '/seo/fallback.png';
  const imageUrl = new URL(sourceImage, ORG.url).toString();
  const imagePathname = new URL(sourceImage, ORG.url).pathname.toLowerCase();
  const width = measuredLegacyImage ? legacy.imageWidth! : 1200;
  const height = measuredLegacyImage ? legacy.imageHeight! : 630;
  const indexable = policy.indexable && !legacy.noindex;
  const ogType = content?.kind === 'article' || content?.kind === 'help' ? 'article'
    : content?.kind === 'creator' ? 'profile'
    : legacy.ogType ?? 'website';
  const resolved: ResolvedSeo = {
    title,
    description,
    canonical,
    indexable,
    robots: indexable
      ? 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
      : 'noindex, follow',
    locale: content?.locale ?? 'en-IN',
    ogType,
    image: {
      url: imageUrl,
      alt: plainText(content?.image?.alt ?? legacy.imageAlt ?? title),
      width,
      height,
      mime: imagePathname.endsWith('.png') ? 'image/png' : 'image/jpeg',
      revision,
    },
    jsonLd: {},
  };
  resolved.jsonLd = buildSeoGraph(content, canonical, title, description, imageUrl);
  return resolved;
}

function publicContentRecord(content: PublicContent): OgResolveResult {
  const policy = resolveRoutePolicy(content.canonicalPath, content);
  const record = policy.indexable ? ogRecordFor(content) : null;
  return record ? { status: 'ok', record } : { status: 'not-found' };
}

function metaFromHtml(html: string, field: string): string | undefined {
  for (const tag of html.match(/<meta\s+[^>]*>/gi) ?? []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gi)].map((m) => [m[1].toLowerCase(), m[3]]));
    if (attrs.name?.toLowerCase() === field || attrs.property?.toLowerCase() === field) return plainText(attrs.content);
  }
  return undefined;
}

function canonicalFromHtml(html: string): string | undefined {
  for (const tag of html.match(/<link\s+[^>]*>/gi) ?? []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gi)].map((m) => [m[1].toLowerCase(), m[3]]));
    if (attrs.rel?.toLowerCase() === 'canonical') return attrs.href;
  }
  return undefined;
}

async function resolvePublicPage(key: string): Promise<OgResolveResult> {
  const path = `/${key}`;
  const initialPolicy = resolveRoutePolicy(path);
  if (initialPolicy.reason === 'archived' || initialPolicy.reason === 'private-or-transactional') return { status: 'not-found' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(canonicalUrl(path), {
      headers: { Accept: 'text/html', 'User-Agent': 'Saathum-OG-Renderer/1.0' },
      redirect: 'manual', signal: controller.signal,
    });
    if (response.status === 404 || response.status === 410 || response.status >= 300 && response.status < 400) return { status: 'not-found' };
    if (!response.ok) return { status: 'unavailable' };
    const html = (await response.text()).slice(0, 300_000);
    const robots = metaFromHtml(html, 'robots');
    const canonical = canonicalFromHtml(html);
    if (!robots || /\bnoindex\b/i.test(robots) || canonical !== canonicalUrl(path)) return { status: 'not-found' };
    const title = metaFromHtml(html, 'og:title') ?? plainText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
    const description = metaFromHtml(html, 'og:description') ?? metaFromHtml(html, 'description');
    if (!title) return { status: 'unavailable' };
    const art = metaFromHtml(html, 'saathum:og-art');
    return publicContentRecord({
      kind: 'page', key, canonicalPath: path, title, summary: description, visibility: 'public',
      publishedAt: metaFromHtml(html, 'article:published_time'),
      modifiedAt: metaFromHtml(html, 'article:modified_time'),
      image: art ? {
        url: art,
        alt: metaFromHtml(html, 'og:image:alt') ?? title,
        revision: metaFromHtml(html, 'saathum:og-art-revision'),
      } : undefined,
    });
  } catch {
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Server-side source of truth for deterministic OG cards. Request data only selects a public record. */
export async function resolveOgRecord(kind: string, key: string): Promise<OgResolveResult> {
  try {
    if (kind === 'home' && key === 'home') {
      const { HOME_SEO } = await import('../homeContent');
      return publicContentRecord(HOME_SEO);
    }
    if (kind === 'collection') {
      const collections: Record<string, PublicContent> = {
        marketplace: MARKETPLACE_SEO,
        help: HELP_SEO,
        rituals: { kind: 'collection', key: 'rituals', canonicalPath: '/rituals', title: 'Puja & Havan Guide', summary: 'Understand traditional pujas and havans, who they are for, and when they are performed.', visibility: 'public' },
      };
      return collections[key] ? publicContentRecord(collections[key]) : { status: 'not-found' };
    }
    if (kind === 'article') {
      const ritual = ritualBySlug(key);
      if (!ritual) return { status: 'not-found' };
      return publicContentRecord({
        kind: 'article', key: ritual.slug, canonicalPath: ritual.href,
        title: `${ritual.title} — Meaning, Story, Benefits & How to Join Live · Saa Thum`,
        summary: `${ritual.description} Why it is offered to ${ritual.deity}, the story behind it, who it is for, and how to join live from anywhere.`,
        visibility: 'public', publishedAt: '2026-09-25', modifiedAt: '2026-09-25',
        image: { url: ritual.image, alt: ritual.imageAlt, revision: ritual.slug },
        article: { authorName: ORG.name, section: ritual.type === 'havan' ? 'Havans' : 'Pujas', keywords: ritual.tags },
        ad: ritualAd(ritual, await fetchPricing()),
      });
    }
    if (kind === 'help') {
      const entry = (await getHelpEntries()).find((item) => item.id === key);
      if (!entry) return { status: 'not-found' };
      const section = SECTIONS[entry.data.section as HelpSectionId];
      return publicContentRecord({
        kind: 'help', key: entry.id, canonicalPath: helpUrl(entry), title: entry.data.title,
        summary: entry.data.description, visibility: 'public', modifiedAt: entry.data.updated.toISOString(),
        article: { authorName: ORG.name, section: section.label, keywords: entry.data.keywords },
      });
    }
    if (kind === 'listing') {
      const listing = await getListing(key);
      const og = listingOg(listing);
      return publicContentRecord(listingContent(listing, og.image ? { url: og.image, alt: listing.title } : undefined));
    }
    if (kind === 'creator') {
      const creator = await getCreator(key);
      const og = creatorOg(creator);
      return publicContentRecord(creatorContent(creator, og.image ? { url: og.image, alt: creator.name ?? `@${creator.handle}` } : undefined));
    }
    if (kind === 'page') return resolvePublicPage(key);
    return { status: 'not-found' };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 410)) return { status: 'not-found' };
    return { status: 'unavailable' };
  }
}
