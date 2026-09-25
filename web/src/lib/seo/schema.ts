import { ORG, orgJsonLd } from '../org';
import { validIso } from './normalize';
import type { PublicContent } from './types';

function breadcrumbs(content: PublicContent): Record<string, unknown> | undefined {
  if (!content.breadcrumbs?.length) return undefined;
  return {
    '@type': 'BreadcrumbList',
    '@id': `${new URL(content.canonicalPath, ORG.url)}#breadcrumbs`,
    itemListElement: content.breadcrumbs.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: new URL(item.path, ORG.url).toString(),
    })),
  };
}

function contentNode(content: PublicContent, canonical: string, description: string, image: string): Record<string, unknown> | undefined {
  if (content.kind === 'article' || content.kind === 'help') {
    const node: Record<string, unknown> = {
      '@type': content.kind === 'help' ? 'TechArticle' : 'Article',
      '@id': `${canonical}#article`,
      url: canonical,
      headline: content.title,
      description,
      image: [image],
      mainEntityOfPage: canonical,
      inLanguage: content.locale ?? 'en-IN',
      author: content.article?.authorName && content.article.authorName !== ORG.name
        ? { '@type': 'Person', name: content.article.authorName }
        : { '@id': `${ORG.url}#organization` },
      publisher: { '@id': `${ORG.url}#organization` },
    };
    const published = validIso(content.publishedAt);
    const modified = validIso(content.modifiedAt);
    if (published) node.datePublished = published;
    if (modified) node.dateModified = modified;
    if (content.article?.section) node.articleSection = content.article.section;
    if (content.article?.keywords?.length) node.keywords = content.article.keywords;
    return node;
  }

  if (content.kind === 'creator' && content.creator) {
    const personId = `${canonical}#person`;
    return {
      '@type': 'ProfilePage',
      '@id': `${canonical}#profile`,
      url: canonical,
      name: content.title,
      description,
      mainEntity: {
        '@type': 'Person',
        '@id': personId,
        name: content.creator.name ?? `@${content.creator.handle}`,
        alternateName: `@${content.creator.handle}`,
        description: content.creator.bio || undefined,
        image,
      },
    };
  }

  if (content.kind === 'listing' && content.listing) {
    const facts = content.listing;
    const type = facts.listingType === 'event' || facts.startsAt ? 'Event'
      : facts.listingType === 'product' ? 'Product' : 'Service';
    const node: Record<string, unknown> = {
      '@type': type,
      '@id': `${canonical}#${type.toLowerCase()}`,
      name: content.title,
      description,
      url: canonical,
      image: [image],
    };
    if (type === 'Event') {
      const starts = validIso(facts.startsAt);
      const ends = validIso(facts.endsAt);
      if (starts) node.startDate = starts;
      if (ends) node.endDate = ends;
      node.eventAttendanceMode = 'https://schema.org/OnlineEventAttendanceMode';
      node.eventStatus = 'https://schema.org/EventScheduled';
      node.location = { '@type': 'VirtualLocation', url: canonical };
      if (facts.free != null) node.isAccessibleForFree = facts.free;
      if (facts.creatorName) node.organizer = { '@type': 'Person', name: facts.creatorName };
    }
    if (type === 'Service' && facts.creatorName) node.provider = { '@type': 'Person', name: facts.creatorName };
    if (type === 'Product') node.brand = { '@id': `${ORG.url}#organization` };
    if (facts.price != null && facts.currency && facts.priceSemantics !== 'none' && facts.priceSemantics !== 'range') {
      const currency = facts.currency.toUpperCase();
      if (facts.priceSemantics === 'from') {
        node.offers = { '@type': 'AggregateOffer', lowPrice: facts.price, priceCurrency: currency, url: canonical };
      } else {
        const unit = facts.billingUnit === '10min' ? { value: 10, unitCode: 'MIN' }
          : facts.billingUnit === 'minute' || facts.priceSemantics === 'per_minute' ? { value: 1, unitCode: 'MIN' }
          : facts.billingUnit === 'hour' || facts.priceSemantics === 'per_hour' ? { value: 1, unitCode: 'HUR' }
          : facts.priceSemantics === 'per_month' ? { value: 1, unitCode: 'MON' }
          : facts.billingUnit && facts.billingUnit !== 'session' ? { value: 1, unitText: facts.billingUnit }
          : undefined;
        node.offers = {
          '@type': 'Offer', price: facts.price, priceCurrency: currency, url: canonical,
          ...(unit ? { priceSpecification: {
            '@type': 'UnitPriceSpecification', price: facts.price, priceCurrency: currency,
            referenceQuantity: { '@type': 'QuantitativeValue', ...unit },
          } } : {}),
        };
      }
    }
    return node;
  }

  if (content.kind === 'collection') {
    return { '@type': 'CollectionPage', '@id': `${canonical}#collection`, url: canonical, name: content.title, description };
  }
  return undefined;
}

export function buildSeoGraph(content: PublicContent | undefined, canonical: string, title: string, description: string, image: string): Record<string, unknown> {
  const base = orgJsonLd({ canonical, title, description, ogImage: image }) as { '@context': string; '@graph': Array<Record<string, unknown>> };
  if (!content) return base;
  const additions = [contentNode(content, canonical, description, image), breadcrumbs(content)].filter(Boolean) as Array<Record<string, unknown>>;
  return { ...base, '@graph': [...base['@graph'], ...additions] };
}
