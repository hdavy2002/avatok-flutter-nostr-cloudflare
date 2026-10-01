// [SAATHUM-SHOP-EDITOR-1 2026-10-01] Small helpers shared by the shop-page blocks (no Puck, no React).
import { createElement, Fragment, type ReactNode } from 'react';
import type { BlockCtx, CollectionGridProps, CollectionInfo, PageItem } from './types';

/** Is this text prop non-empty? Inside the Puck canvas an inline-editable field is a React node, which counts as present. */
export function has(v: unknown): boolean {
  return typeof v === 'string' ? v.trim() !== '' : v !== null && v !== undefined && v !== false;
}

/** A text prop as something React can render (a string on the live page, a node in the editor canvas). */
export const t = (v: unknown): ReactNode => v as ReactNode;

/** Only site paths and https links are ever rendered as hrefs. */
export function safeHref(h: unknown, fallback = '/shop/all'): string {
  const s = typeof h === 'string' ? h.trim() : '';
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  if (/^https:\/\//i.test(s)) return s;
  return fallback;
}

/** The old mockup's DOM ids for the two original rails (kept so nothing that targets them breaks). */
export function railDomId(blockId: string): string {
  if (blockId === 'new-arrivals') return 'shNew';
  if (blockId === 'bestsellers') return 'shBest';
  return `shRail-${blockId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}
export function railSourceKey(blockId: string, source: string): string {
  if (blockId === 'new-arrivals') return 'home_new';
  if (blockId === 'bestsellers') return 'home_best';
  return `home_${source}`;
}

export interface CollectionTile { c: CollectionInfo; image: string | null; name: string; blurb: string }

/**
 * The tiles of a "Shop by collection" block. No tiles configured = every active collection in the admin's order with its own photo.
 * [SAATHUM-SHOP-EDITOR-2] On the LIVE page only collections that hold at least one live product are shown (the owner: "once products are
 * under a collection I should start to see it"); the editor shows every active collection so a new one can be checked straight away.
 */
export function collectionTiles(p: Pick<CollectionGridProps, 'tiles'>, collections: CollectionInfo[], editing = false): CollectionTile[] {
  const tiles: CollectionTile[] = (p.tiles ?? []).length
    ? p.tiles.map((x) => {
        const c = collections.find((k) => k.slug === x.collection);
        return c ? { c, image: x.image || c.image_url, name: x.label || c.name, blurb: x.blurb || c.blurb } : null;
      }).filter((x): x is CollectionTile => !!x)
    : collections.map((c) => ({ c, image: c.image_url, name: c.name, blurb: c.blurb }));
  return editing ? tiles : tiles.filter((x) => x.c.count > 0);
}

/** Does this block put anything on the page? (A hidden empty rail / a collection grid with no qualifying collection / a title-less banner does not.) */
export function isVisible(item: PageItem, ctx: BlockCtx): boolean {
  if (item.type === 'ProductRail') return (ctx.resolved.rails[item.props.id]?.length ?? 0) > 0 || !item.props.hideWhenEmpty;
  if (item.type === 'CollectionGrid') return collectionTiles(item.props, ctx.collections).length > 0;
  if (item.type === 'FeaturedBanner') return has(item.props.title);
  return true;
}

/** The slice of the page context one block actually needs — keeps the hydrated island props small. */
export function slimCtx(item: PageItem, ctx: BlockCtx): BlockCtx {
  if (item.type === 'ShopHero') {
    const products: BlockCtx['resolved']['products'] = {};
    for (const h of item.props.hotspots ?? []) if (ctx.resolved.products[h.product]) products[h.product] = ctx.resolved.products[h.product];
    return { collections: ctx.collections.map((c) => ({ ...c, blurb: '', image_url: null })), resolved: { products, rails: {} } };
  }
  if (item.type === 'ProductRail') {
    return { collections: [], resolved: { products: {}, rails: { [item.props.id]: ctx.resolved.rails[item.props.id] ?? [] } } };
  }
  if (item.type === 'FeaturedBanner') {
    const pr = ctx.resolved.products[item.props.product];
    return { collections: [], resolved: { products: pr ? { [item.props.product]: pr } : {}, rails: {} } };
  }
  return ctx;
}

/** " " + text as ONE text node on the live page (browsers shape separate text nodes slightly differently), a node pair in the editor. */
export function spaced(v: unknown): ReactNode {
  return typeof v === 'string' ? ` ${v}` : createElement(Fragment, null, ' ', v as ReactNode);
}
