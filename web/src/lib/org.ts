// [WEB-SEO-5 2026-09-10] Single source of truth for the brand/company facts
// that feed structured data (and, gradually, the visible chrome) across the
// site. Before this file, the Organization/WebSite/WebPage JSON-LD graph was
// defined inline in Base.astro's frontmatter — correct, but it meant "add the
// Pvt Ltd name" or "add the Instagram link" required understanding and
// editing a raw schema.org object. Now those are one field each, here.
//
// Everything below carries forward the reasoning that used to live as a
// comment above Base.astro's `orgLd` ([WEB-SEO-1]/[WEB-SEO-2]) — read it
// before changing a value, not just the field's name.
//
// NAMING RULE (owner decision 2026-09-10, consistent with the "no company"
// rule in the repo's CLAUDE.md): the Organization is the BRAND, avaTOK.
// `parent` is AvaGlobal Inc (Delaware), which handles international traffic
// and does exist. The Indian entity, Ava Global International Pvt Ltd
// (Mumbai), is in process and must NOT be named anywhere on the site until it
// is actually registered — naming it now would contradict /terms#status (see
// `LegalStatus.astro`, the "THERE IS NO COMPANY" section of CLAUDE.md, and
// issue [LEGAL-UNREG-1]).
//
// `sameAs` must only list profiles that resolve today. The Play listing is
// Closed Alpha and returns 404 to the public, so it is deliberately absent —
// a 404 in sameAs is worse than no entry. Add it once the app is public.
//
// A field set to `null` means "not known / not public yet" and is OMITTED
// from the JSON-LD output by `orgJsonLd()` below — it never emits `null`,
// an empty string, or a placeholder into the graph.

export interface PostalAddress {
  /** City. Always set — the site never publishes a street address (see
   *  CLAUDE.md "THERE IS NO COMPANY": no street address, no company name,
   *  until the Indian entity is actually registered). */
  locality: string;
  region: string;
  country: string;
  /** Set only once a real, publishable street address exists. */
  street: string | null;
  postalCode: string | null;
}

export interface ParentOrg {
  name: string;
  region: string;
  country: string;
}

export interface SameAs {
  youtube: string | null;
  instagram: string | null;
  /** Closed Alpha today — the public listing 404s. Set once the app is public. */
  playStore: string | null;
}

export interface OrgLogo {
  url: string;
  width: number;
  height: number;
}

export interface OrgConstants {
  /** The brand name. This is the Organization's `name` — see NAMING RULE above. */
  name: string;
  alternateNames: string[];
  /**
   * The registered legal name, e.g. 'Ava Global International Pvt Ltd'.
   * Stays `null` until the Indian entity is actually incorporated — see the
   * NAMING RULE above and CLAUDE.md's "THERE IS NO COMPANY" section. Setting
   * this is a one-line change here, but it must happen in the SAME change as
   * updating `LegalStatus.astro` and `SiteFooter.astro` per that section.
   */
  legalName: string | null;
  url: string;
  logo: OrgLogo;
  description: string;
  slogan: string;
  foundingDate: string;
  email: string;
  address: PostalAddress;
  parent: ParentOrg;
  sameAs: SameAs;
  languages: string[];
  contactUrl: string;
  /** {search_term_string} is a literal template placeholder, not interpolated here. */
  searchUrlTemplate: string;
}

export const ORG: OrgConstants = {
  name: 'avaTOK',
  alternateNames: ['AvaTOK', 'AvaTok', 'Avatok', 'avatok.ai'],
  // Set to 'Ava Global International Pvt Ltd' once the Mumbai entity is
  // registered. See the class comment above `legalName` for the required
  // companion edits.
  legalName: null,
  url: 'https://avatok.ai/',
  logo: {
    url: 'https://avatok.ai/app-logo2.png',
    width: 251,
    height: 256,
  },
  description:
    'avaTOK is an India-focused creator marketplace for paid live streaming and 1:1 video sessions. Creators publish listings, people book or join, and creators get paid — including for skills, conversations and experiences hosted from home.',
  slogan: 'Apna hunar. Apni kamaai.',
  foundingDate: '2025',
  email: 'support@avatok.ai',
  address: {
    locality: 'Mumbai',
    region: 'Maharashtra',
    country: 'IN',
    // No street address until the Indian entity is registered — see
    // CLAUDE.md "THERE IS NO COMPANY".
    street: null,
    postalCode: null,
  },
  parent: {
    name: 'AvaGlobal Inc',
    region: 'Delaware',
    country: 'US',
  },
  sameAs: {
    youtube: 'https://www.youtube.com/@avatok',
    // Set once a real, resolving Instagram profile exists.
    instagram: null,
    // Closed Alpha — 404s publicly today. Set once the Play listing is public.
    playStore: null,
  },
  languages: ['en', 'hi'],
  contactUrl: '/contact',
  searchUrlTemplate: 'https://avatok.ai/marketplace?q={search_term_string}',
};

/** Filters `ORG.sameAs` down to the profiles that are actually set. */
export function sameAsList(): string[] {
  return Object.values(ORG.sameAs).filter((v): v is string => v != null);
}

export interface PageLdInput {
  canonical: string;
  title: string;
  description: string;
  ogImage: string;
}

/**
 * Builds the site-wide Organization/WebSite/WebPage JSON-LD graph from ORG.
 * Answer engines read this to decide what avaTOK *is*; keep it consistent
 * with the visible copy on /about. This is the same graph shape Base.astro
 * used to build inline ([WEB-SEO-1]/[WEB-SEO-2]) — same @ids, same nodes —
 * just sourced from ORG so one field edit here reaches every page.
 *
 * [WEB-SEO-2 2026-09-10] Enriched for Google's knowledge panel and
 * sitelinks. The panel Google draws beside a brand search is assembled from
 * the Knowledge Graph, and the Knowledge Graph is fed by exactly the fields
 * below: a square logo (>=112px, ImageObject), `sameAs` official profiles, a
 * parent organisation, founding date, contact point and a locality. The
 * WebSite node gains a SearchAction so Google can offer a sitelinks search
 * box that posts to /marketplace?q=. None of this is a ranking signal — it
 * is what lets Google SHOW more once the pages rank.
 */
export function orgJsonLd({ canonical, title, description, ogImage }: PageLdInput): object {
  const orgId = `${ORG.url}#organization`;
  const websiteId = `${ORG.url}#website`;
  const logoId = `${ORG.url}#logo`;

  const organization: Record<string, unknown> = {
    '@type': 'Organization',
    '@id': orgId,
    name: ORG.name,
    alternateName: ORG.alternateNames,
    url: ORG.url,
    logo: {
      '@type': 'ImageObject',
      '@id': logoId,
      url: ORG.logo.url,
      contentUrl: ORG.logo.url,
      width: ORG.logo.width,
      height: ORG.logo.height,
      caption: ORG.name,
    },
    image: { '@id': logoId },
    description: ORG.description,
    slogan: ORG.slogan,
    foundingDate: ORG.foundingDate,
    parentOrganization: {
      '@type': 'Organization',
      name: ORG.parent.name,
      address: {
        '@type': 'PostalAddress',
        addressRegion: ORG.parent.region,
        addressCountry: ORG.parent.country,
      },
    },
    address: {
      '@type': 'PostalAddress',
      addressLocality: ORG.address.locality,
      addressRegion: ORG.address.region,
      addressCountry: ORG.address.country,
      ...(ORG.address.street != null ? { streetAddress: ORG.address.street } : {}),
      ...(ORG.address.postalCode != null ? { postalCode: ORG.address.postalCode } : {}),
    },
    areaServed: { '@type': 'Country', name: 'India' },
    knowsLanguage: ORG.languages,
    email: ORG.email,
    contactPoint: [
      {
        '@type': 'ContactPoint',
        contactType: 'customer support',
        email: ORG.email,
        url: new URL(ORG.contactUrl, ORG.url).toString(),
        areaServed: 'IN',
        availableLanguage: ['English', 'Hindi'],
      },
    ],
    sameAs: sameAsList(),
  };
  if (ORG.legalName != null) {
    organization.legalName = ORG.legalName;
  }

  const website = {
    '@type': 'WebSite',
    '@id': websiteId,
    url: ORG.url,
    name: ORG.name,
    alternateName: 'avatok.ai',
    description,
    inLanguage: 'en-IN',
    publisher: { '@id': orgId },
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: ORG.searchUrlTemplate,
      },
      'query-input': 'required name=search_term_string',
    },
  };

  const webPage = {
    '@type': 'WebPage',
    '@id': `${canonical}#webpage`,
    url: canonical,
    name: title,
    description,
    isPartOf: { '@id': websiteId },
    about: { '@id': orgId },
    inLanguage: 'en-IN',
    primaryImageOfPage: { '@type': 'ImageObject', url: ogImage },
  };

  return {
    '@context': 'https://schema.org',
    '@graph': [organization, website, webPage],
  };
}
