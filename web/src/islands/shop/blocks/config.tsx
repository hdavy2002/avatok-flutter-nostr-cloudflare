// [SAATHUM-SHOP-EDITOR-1 2026-10-01] The Puck config for the /shop home page editor (ADMIN CHUNK ONLY — the public page never imports this).
// Every block renders the SAME component the live page renders (./*Block.tsx); this file only adds fields, defaults and the
// editing wrappers (no navigation, no cart). Text fields use `contentEditable` so the owner clicks the words on the canvas and types.
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Config } from '@puckeditor/core';
import ShopHeroBlock from './ShopHeroBlock';
import CollectionGridBlock from './CollectionGridBlock';
import ProductRailBlock from './ProductRailBlock';
import FeaturedBannerBlock from './FeaturedBannerBlock';
import PhotoBannerBlock from './PhotoBannerBlock';
import TextSectionBlock from './TextSectionBlock';
import { useEditCtx } from './editorCtx';
import type { BlockCtx } from './types';

/* ───────── custom sidebar fields ───────── */

function ImageFieldUI({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const { upload } = useEditCtx();
  const ref = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showUrl, setShowUrl] = useState(false);
  return (
    <div className="pe-img">
      <div className="pe-img-box">{value ? <img src={value} alt="" /> : <span>No photo yet</span>}</div>
      <div className="pe-img-row">
        <button type="button" className="pe-btn" disabled={busy} onClick={() => ref.current?.click()}>{busy ? 'Uploading…' : value ? 'Replace photo' : 'Upload photo'}</button>
        {value ? <button type="button" className="pe-btn pe-btn--ghost" onClick={() => onChange('')}>Remove</button> : null}
        <button type="button" className="pe-link" onClick={() => setShowUrl((s) => !s)}>{showUrl ? 'Hide link' : 'Use a link'}</button>
      </div>
      {showUrl && <input className="pe-input" type="url" placeholder="https://…" defaultValue={value ?? ''} onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v !== (value ?? '')) onChange(v); }} />}
      {err && <p className="pe-err" role="alert">{err}</p>}
      <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        setBusy(true); setErr('');
        try { onChange(await upload(f)); } catch (er) { setErr(er instanceof Error ? er.message : 'The photo could not be uploaded.'); } finally { setBusy(false); }
      }} />
      <small>JPG, PNG or WebP, up to 8 MB.</small>
    </div>
  );
}

function ProductSelectUI({ value, onChange, empty }: { value?: string; onChange: (v: string) => void; empty: string }) {
  const { products } = useEditCtx();
  const known = !value || products.some((p) => p.id === value);
  return (
    <select className="pe-input" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {!known && <option value={value}>(a product that is no longer live)</option>}
      {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}

function CollectionSelectUI({ value, onChange, empty }: { value?: string; onChange: (v: string) => void; empty: string }) {
  const { collections } = useEditCtx();
  return (
    <select className="pe-input" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {collections.map((c) => <option key={c.id} value={c.slug}>{c.name}</option>)}
    </select>
  );
}

const imageField = (label: string) => ({ type: 'custom' as const, label, render: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => <ImageFieldUI value={value} onChange={onChange} /> });
const productField = (label: string, empty = 'Choose a product…') => ({ type: 'custom' as const, label, render: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => <ProductSelectUI value={value} onChange={onChange} empty={empty} /> });
const collectionField = (label: string, empty: string) => ({ type: 'custom' as const, label, render: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => <CollectionSelectUI value={value} onChange={onChange} empty={empty} /> });
const text = (label: string) => ({ type: 'text' as const, label, contentEditable: true });
const textarea = (label: string) => ({ type: 'textarea' as const, label, contentEditable: true });

/* ───────── canvas wrappers ───────── */

/** Nothing inside the canvas may navigate (links) — the cart and wishlist are blocked per block (pointer-events). */
function Canvas({ children, wrap = true }: { children: ReactNode; wrap?: boolean }) {
  return (
    <div className="sh-editing" onClickCapture={(e) => { if ((e.target as HTMLElement).closest('a')) e.preventDefault(); }}>
      {wrap ? <div className="sh-wrap">{children}</div> : children}
    </div>
  );
}

function useBlockCtx(): BlockCtx {
  const { collections, resolved } = useEditCtx();
  return { collections, resolved, editing: true };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const HeroEd = (p: any) => <Canvas wrap={false}><ShopHeroBlock {...p} ctx={useBlockCtx()} /></Canvas>;
const GridEd = (p: any) => <Canvas><CollectionGridBlock {...p} ctx={useBlockCtx()} /></Canvas>;
const RailEd = (p: any) => <Canvas><ProductRailBlock {...p} ctx={useBlockCtx()} /></Canvas>;
const BannerEd = (p: any) => <Canvas><FeaturedBannerBlock {...p} ctx={useBlockCtx()} /></Canvas>;
const PhotoEd = (p: any) => <Canvas><PhotoBannerBlock {...p} /></Canvas>;
const TextEd = (p: any) => <Canvas><TextSectionBlock {...p} /></Canvas>;

const summary = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v : fallback);

export const shopPageConfig = {
  root: {
    // The right-hand panel shows these when no block is selected (it used to be an empty "Page" box).
    fields: {
      guide: { type: 'custom', label: 'How to edit this page', render: () => (
        <p className="pe-guide">Click any section on the page to change its words, link and photo here. Click words directly on the page to type over them. Nothing goes live until you press Publish.</p>
      ) },
    },
    render: ({ children }: { children?: ReactNode }) => (
      <div className="folk-site" data-design="reference-v5"><main className="sh">{children}</main></div>
    ),
  },
  components: {
    ShopHero: {
      label: 'Hero (big photo + words)',
      fields: {
        image: imageField('Hero photo'),
        eyebrow: text('Small line above the title'),
        title: text('Title'),
        titleEm: text('Highlighted words (red)'),
        lead: textarea('Paragraph'),
        ctaLabel: text('Main button text'),
        secondCollection: collectionField('Second button opens collection', 'The first collection'),
        ticks: { type: 'array', label: 'Tick lines', max: 6, arrayFields: { text: { type: 'text', label: 'Text' } }, defaultItemProps: { text: 'New tick' }, getItemSummary: (i: any) => summary(i.text, 'Tick') },
        promise: { type: 'array', label: 'Promise strip (up to 3)', max: 3, arrayFields: { title: { type: 'text', label: 'Title' }, sub: { type: 'text', label: 'Small text' } }, defaultItemProps: { title: 'Promise', sub: 'Small text' }, getItemSummary: (i: any) => summary(i.title, 'Promise') },
        promiseLinkLabel: text('Link in the promise strip'),
        hotspots: {
          type: 'array', label: 'Dots on the photo (up to 8)', max: 8,
          arrayFields: { product: productField('Product'), x: { type: 'number', label: 'Across %', min: 0, max: 100 }, y: { type: 'number', label: 'Down %', min: 0, max: 100 } },
          defaultItemProps: { product: '', x: 50, y: 50 }, getItemSummary: (_i: any, n: number) => `Dot ${n + 1}`,
        },
      },
      defaultProps: {
        image: '', eyebrow: 'New season', title: 'Your headline,', titleEm: 'highlighted.', lead: 'A short paragraph about this page.', ctaLabel: 'Shop all T-shirts →',
        secondCollection: '', ticks: [{ text: 'A tick line' }], promise: [{ title: 'Free shipping', sub: 'Pan India, every order' }], promiseLinkLabel: 'Tap a dot to shop the stack →', hotspots: [],
      },
      render: HeroEd,
    },
    CollectionGrid: {
      label: 'Shop by collection',
      fields: {
        title: text('Heading'), subtitle: text('Line under the heading'), linkLabel: text('Link text'),
        tiles: {
          type: 'array', label: 'Tiles (leave empty to show every collection with its own photo)', max: 12,
          arrayFields: { collection: collectionField('Collection', 'Choose…'), image: imageField('Photo (instead of the collection photo)'), label: { type: 'text', label: 'Name (optional)' }, blurb: { type: 'text', label: 'Small text (optional)' } },
          defaultItemProps: { collection: '', image: '', label: '', blurb: '' },
          getItemSummary: (i: any) => summary(i.label || i.collection, 'Tile'),
        },
      },
      defaultProps: { title: 'Shop by collection', subtitle: 'Every design starts from a story — a deity, a temple, a mantra.', linkLabel: 'All collections', tiles: [] },
      render: GridEd,
    },
    ProductRail: {
      label: 'Product row',
      fields: {
        title: text('Heading'), subtitle: text('Line under the heading'), linkLabel: text('Link text (empty hides it)'),
        linkHref: { type: 'text', label: 'Link goes to (a /path or https link)' },
        source: {
          type: 'select', label: 'Which products',
          options: [
            { label: 'New arrivals (products marked New arrival)', value: 'new_arrivals' }, { label: 'Bestsellers (products marked Bestseller)', value: 'bestsellers' },
            { label: 'On sale', value: 'sale' }, { label: 'One collection', value: 'collection' }, { label: 'Hand-picked', value: 'manual' },
          ],
        },
        collection: collectionField('Collection (for "One collection")', 'Choose…'),
        products: { type: 'array', label: 'Products (for "Hand-picked")', max: 24, arrayFields: { product: productField('Product') }, defaultItemProps: { product: '' }, getItemSummary: (i: any) => i.product ? 'Product' : 'Choose a product' },
        count: { type: 'number', label: 'How many (1–12)', min: 1, max: 12 },
        hideWhenEmpty: { type: 'radio', label: 'When there are no products', options: [{ label: 'Hide this row', value: true }, { label: 'Show the message below', value: false }] },
        emptyTitle: text('Message title'), emptyText: textarea('Message text'),
        emptyButtonLabel: text('Message button text'), emptyButtonHref: { type: 'text', label: 'Message button goes to' },
      },
      defaultProps: {
        title: 'More to wear', subtitle: 'Picked for you.', linkLabel: 'View all', linkHref: '/shop/all', source: 'new_arrivals', collection: '', products: [], count: 4, hideWhenEmpty: true,
        emptyTitle: '', emptyText: '', emptyButtonLabel: '', emptyButtonHref: '',
      },
      render: RailEd,
    },
    FeaturedBanner: {
      label: 'Featured banner',
      fields: {
        eyebrow: text('Small line above the title'), title: text('Title'), text: textarea('Text'), ctaLabel: text('Button text'),
        ctaHref: { type: 'text', label: 'Button goes to (a /path or https link)' },
        product: productField('Product the button opens (optional — overrides the link)'), image: imageField('Banner photo (empty = the product photo)'),
      },
      defaultProps: {
        eyebrow: 'Featured · Navratri drop', title: 'The Lotus & Diya tee — light for every home.',
        text: 'Hand-drawn folk lotus with a lit diya at its heart. Off-white cotton, soft red and gold ink.',
        ctaLabel: 'See the tee →', ctaHref: '/shop/all', product: '', image: '',
      },
      render: BannerEd,
    },
    PhotoBanner: {
      label: 'Photo banner',
      fields: {
        image: imageField('Photo'), heading: text('Heading (optional)'), text: textarea('Text (optional)'), ctaLabel: text('Button text (optional)'),
        ctaHref: { type: 'text', label: 'Button goes to (a /path or https link)' },
        height: { type: 'radio', label: 'Height', options: [{ label: 'Short', value: 'short' }, { label: 'Medium', value: 'medium' }, { label: 'Tall', value: 'tall' }] },
      },
      defaultProps: { image: '', heading: 'A heading', text: '', ctaLabel: '', ctaHref: '/shop/all', height: 'medium' },
      render: PhotoEd,
    },
    TextSection: {
      label: 'Heading + paragraph',
      fields: { heading: text('Heading'), text: textarea('Paragraph') },
      defaultProps: { heading: 'A heading', text: 'Write a short paragraph here.' },
      render: TextEd,
    },
  },
} as unknown as Config;
