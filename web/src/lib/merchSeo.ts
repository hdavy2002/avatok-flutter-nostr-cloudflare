/* [HF-MERCH-FAN-WEB-1] JSON-LD for the influencer page and the merch product page (schema.org). Pure functions: the facts here are the
 * same ones the page shows (visible claims and schema facts must match - lib/seo/README.md). Brand and origin come from lib/brand. */
import { BRAND } from './brand';
import type { PublicProduct, PublicProductFull } from './merchPublic';

const abs = (u: string | null | undefined): string | undefined => {
  if (!u) return undefined;
  try { return new URL(u, BRAND.webOrigin).toString(); } catch { return undefined; }
};
const clean = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')) as T;

export interface ProfileFacts {
  slug: string; name: string; description: string; imageUrl?: string | null;
  /** Their own public social profile pages (https only). Left out when the API sends none. */
  sameAs?: string[]; rating?: number | null; reviewCount?: number;
}

/** ProfilePage + Person for /h/<slug>. aggregateRating only when there is at least one review. */
export function profileJsonLd(f: ProfileFacts): Record<string, unknown> {
  const url = new URL(`/h/${f.slug}`, BRAND.webOrigin).toString();
  const person = clean({
    '@type': 'Person', '@id': `${url}#person`, name: f.name, url, description: f.description, image: abs(f.imageUrl),
    sameAs: (f.sameAs ?? []).filter((s) => /^https:\/\//.test(s)).slice(0, 8),
    aggregateRating: f.rating != null && (f.reviewCount ?? 0) > 0
      ? { '@type': 'AggregateRating', ratingValue: Number(f.rating.toFixed(1)), reviewCount: f.reviewCount, bestRating: 5, worstRating: 1 } : undefined,
  });
  if (Array.isArray(person.sameAs) && person.sameAs.length === 0) delete (person as Record<string, unknown>).sameAs;
  return { '@context': 'https://schema.org', '@type': 'ProfilePage', '@id': `${url}#profile`, url, name: f.name, mainEntity: person };
}

/** Product + Offer for /h/<slug>/merch/<product>: INR, in stock, free shipping in India, brand = the influencer. */
export function productJsonLd(host: { slug: string; displayName: string }, p: PublicProductFull | PublicProduct, photos: string[], description: string, category = 'Merchandise'): Record<string, unknown> {
  const url = new URL(`/h/${host.slug}/merch/${p.slug}`, BRAND.webOrigin).toString();
  const shipping = {
    '@type': 'OfferShippingDetails',
    shippingRate: { '@type': 'MonetaryAmount', value: 0, currency: 'INR' },
    shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'IN' },
    deliveryTime: { '@type': 'ShippingDeliveryTime', handlingTime: { '@type': 'QuantitativeValue', minValue: 2, maxValue: 5, unitCode: 'DAY' }, transitTime: { '@type': 'QuantitativeValue', minValue: 3, maxValue: 7, unitCode: 'DAY' } },
  };
  const returns = { '@type': 'MerchantReturnPolicy', applicableCountry: 'IN', returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted' };
  const sizes = p.sizes.length ? p.sizes : [{ size: '', pricePaise: p.fromPricePaise, inStock: true }];
  const offers = sizes.map((s) => clean({
    '@type': 'Offer', url, name: s.size ? `Size ${s.size}` : undefined, price: Number((s.pricePaise / 100).toFixed(2)), priceCurrency: 'INR',
    availability: s.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', itemCondition: 'https://schema.org/NewCondition',
    shippingDetails: shipping, hasMerchantReturnPolicy: returns,
  }));
  return clean({
    '@context': 'https://schema.org', '@type': 'Product', '@id': `${url}#product`, name: p.title, description, url, sku: p.id,
    image: photos.map(abs).filter(Boolean),
    brand: { '@type': 'Brand', name: host.displayName },
    color: p.colours.length ? p.colours.map((c) => c.name).join(', ') : undefined,
    category,
    offers: offers.length === 1 ? offers[0] : offers,
  });
}
