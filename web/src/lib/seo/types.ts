export type PublicContentKind =
  | 'home'
  | 'page'
  | 'collection'
  | 'article'
  | 'help'
  | 'listing'
  | 'creator'
  | 'agent';

export type ContentVisibility = 'public' | 'unlisted' | 'private' | 'draft' | 'archived';
export type ContentState = 'active' | 'ended' | 'cancelled' | 'expired';

export interface ContentImage {
  url: string;
  alt: string;
  revision?: string;
}

export interface Breadcrumb {
  name: string;
  path: string;
}

export interface ArticleFacts {
  authorName?: string;
  section?: string;
  keywords?: string[];
}

export interface ListingFacts {
  startsAt?: string;
  endsAt?: string;
  price?: number;
  currency?: string;
  priceSemantics?: string;
  billingUnit?: string;
  free?: boolean;
  creatorName?: string;
  listingType?: 'event' | 'service' | 'product';
}

export interface CreatorFacts {
  handle: string;
  name?: string;
  bio?: string;
}

export interface PublicContent {
  kind: PublicContentKind;
  key: string;
  canonicalPath: string;
  title: string;
  summary?: string;
  plainText?: string;
  locale?: 'en-IN';
  visibility: ContentVisibility;
  state?: ContentState;
  publishedAt?: string;
  modifiedAt?: string;
  image?: ContentImage;
  breadcrumbs?: Breadcrumb[];
  article?: ArticleFacts;
  listing?: ListingFacts;
  creator?: CreatorFacts;
}

export interface SeoImage {
  url: string;
  alt: string;
  width: number;
  height: number;
  mime: 'image/png' | 'image/jpeg';
  revision: string;
}

export interface ResolvedSeo {
  title: string;
  description: string;
  canonical: string;
  robots: string;
  indexable: boolean;
  locale: string;
  ogType: 'website' | 'article' | 'profile';
  image: SeoImage;
  jsonLd: Record<string, unknown>;
}

export interface LegacySeoInput {
  title?: string;
  description?: string;
  image?: string;
  imageAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
  ogType?: 'website' | 'article' | 'profile';
  noindex?: boolean;
}
