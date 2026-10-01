// [SAATHUM-SHOP-EDITOR-1 2026-10-01] Shared shapes of the editable /shop home page.
// The page is stored as Puck data ({ root, content[] }) — one item per block. This file is PURE TYPES:
// the public page, the admin editor and the worker tests all import it, so it must never import Puck or React.
import type { ShopCard } from '../../../lib/shopApi';

export const BLOCK_TYPES = ['ShopHero', 'CollectionGrid', 'ProductRail', 'FeaturedBanner', 'PhotoBanner', 'TextSection'] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** Text props are plain strings in storage; inside the Puck canvas an inline-editable field arrives as a React node. */
export type Txt = unknown;

export interface HeroProps {
  image: string;
  eyebrow: Txt; title: Txt; titleEm: Txt; lead: Txt; ctaLabel: Txt;
  secondCollection: string;
  ticks: { text: string }[];
  promise: { title: string; sub: string }[];
  promiseLinkLabel: Txt;
  hotspots: { product: string; x: number; y: number }[];
}

export interface CollectionGridProps {
  title: Txt; subtitle: Txt; linkLabel: Txt;
  tiles: { collection: string; image: string; label: string; blurb: string }[];
}

export type RailSource = 'new_arrivals' | 'bestsellers' | 'sale' | 'collection' | 'manual';
export const RAIL_SOURCES: RailSource[] = ['new_arrivals', 'bestsellers', 'sale', 'collection', 'manual'];

export interface ProductRailProps {
  title: Txt; subtitle: Txt; linkLabel: Txt; linkHref: string;
  source: RailSource; collection: string; products: { product: string }[]; count: number;
  hideWhenEmpty: boolean;
  emptyTitle: Txt; emptyText: Txt; emptyButtonLabel: Txt; emptyButtonHref: string;
}

export interface FeaturedBannerProps {
  eyebrow: Txt; title: Txt; text: Txt; ctaLabel: Txt;
  /** Where the button goes when no product is picked (a /path or https link). A picked product's page wins. */
  ctaHref: string;
  product: string; image: string;
}

export interface PhotoBannerProps {
  image: string; heading: Txt; text: Txt; ctaLabel: Txt; ctaHref: string; height: 'short' | 'medium' | 'tall';
}

export interface TextSectionProps { heading: Txt; text: Txt }

export interface BlockPropsMap {
  ShopHero: HeroProps; CollectionGrid: CollectionGridProps; ProductRail: ProductRailProps;
  FeaturedBanner: FeaturedBannerProps; PhotoBanner: PhotoBannerProps; TextSection: TextSectionProps;
}

export type PageItem = { [T in BlockType]: { type: T; props: BlockPropsMap[T] & { id: string } } }[BlockType];

/** Puck's data envelope. `zones` is never used (no nested slots). */
export interface PageData { root: { props: Record<string, unknown> }; content: PageItem[]; zones?: Record<string, unknown> }

/** What the blocks need besides their own props, resolved by the worker (public) or the resolve endpoint (editor). */
export interface ShopResolved {
  /** Every product a block references (hotspots, banner, manual rails) by id. */
  products: Record<string, ShopCard>;
  /** The product list of every ProductRail, by block id. */
  rails: Record<string, ShopCard[]>;
}

export interface CollectionInfo { id: string; slug: string; name: string; blurb: string; image_url: string | null; count: number }

/** Everything a block component needs to render. */
export interface BlockCtx {
  collections: CollectionInfo[];
  resolved: ShopResolved;
  /** True inside the admin canvas: nothing may navigate or touch the cart. */
  editing?: boolean;
  /** True for the last visible block of the page (the page's bottom padding rule). */
  last?: boolean;
}

export const emptyResolved = (): ShopResolved => ({ products: {}, rails: {} });
