/* [HF-MERCH-STUDIO-2] Konva helpers shared by the on-screen stage (engine.ts) and the print export (exportPrint.ts), so the print is exactly what the owner saw.
 * Konva is imported dynamically only (it needs a browser; the island is server-rendered). */
import type Konva from 'konva';
import { DEFAULT_FONT } from './fonts';
import type { ImageLayer, Layer, TextLayer } from './types';

export type KonvaLib = typeof Konva;
let lib: Promise<KonvaLib> | null = null;
export function getKonva(): Promise<KonvaLib> {
  if (!lib) lib = import('konva').then(m => m.default);
  return lib;
}

/* ── images ───────────────────────────────────────────────────────────── */
const imgCache = new Map<string, Promise<HTMLImageElement>>();
function loadOnce(src: string, cors: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image_load_failed'));
    img.src = src;
  });
}
/** For the screen: tries a CORS-clean load first (so nothing taints), falls back to a plain load (display only). */
export function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imgCache.get(src);
  if (!p) {
    const local = /^(blob:|data:)/.test(src);
    p = loadOnce(src, !local).catch(() => (local ? Promise.reject(new Error('image_load_failed')) : loadOnce(src, false)));
    p.catch(() => { imgCache.delete(src); });
    imgCache.set(src, p);
  }
  return p;
}

/* ── text ─────────────────────────────────────────────────────────────── */
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Applies the text look of a layer to a Konva.Text. `P` = px per inch. Returns the measured size in px (unrotated). */
function styleText(node: Konva.Text, l: TextLayer, P: number): { w: number; h: number } {
  const fs = Math.max(2, l.sizeIn * P);
  node.setAttrs({
    text: l.text || ' ', fontFamily: l.font || DEFAULT_FONT, fontSize: fs, fill: l.fill, align: l.align,
    letterSpacing: l.letterSpacing * fs, lineHeight: l.lineHeight,
    fontStyle: `${l.italic ? 'italic ' : ''}${l.bold ? 'bold' : 'normal'}`.trim(),
    stroke: l.stroke ?? undefined, strokeWidth: l.stroke ? Math.max(0, l.strokeIn * P) : 0, fillAfterStrokeEnabled: true, lineJoin: 'round',
    shadowEnabled: l.shadow, shadowColor: '#000000', shadowBlur: l.shadow ? fs * 0.12 : 0,
    shadowOffsetX: l.shadow ? fs * 0.05 : 0, shadowOffsetY: l.shadow ? fs * 0.06 : 0, shadowOpacity: l.shadow ? 0.5 : 0,
    wrap: 'none',
  });
  return { w: node.width(), h: node.height() };
}

const measureCache = new Map<string, { w: number; h: number }>();
/** Size in inches of a text layer (measured with the loaded font; call again after a font finishes loading). */
export function textSizeIn(K: KonvaLib, l: TextLayer): { w: number; h: number } {
  const key = `${l.text}|${l.font}|${l.sizeIn}|${l.letterSpacing}|${l.lineHeight}|${l.strokeIn}|${l.stroke ? 1 : 0}|${l.bold}|${l.italic}|${fontReadyFlag(l.font)}`;
  const hit = measureCache.get(key);
  if (hit) return hit;
  const t = new K.Text({});
  const s = styleText(t, l, 100);
  t.destroy();
  const r = { w: s.w / 100, h: s.h / 100 };
  if (measureCache.size > 400) measureCache.clear();
  measureCache.set(key, r);
  return r;
}
let readySet: Set<string> = new Set();
export function markFontReady(family: string): void { readySet = new Set(readySet).add(family); }
const fontReadyFlag = (family: string): number => (readySet.has(family) ? 1 : 0);

/** Size in inches of any layer, before rotation. */
export function layerSizeIn(K: KonvaLib, l: Layer): { w: number; h: number } {
  return l.type === 'image' ? { w: l.w, h: l.h } : textSizeIn(K, l);
}

/** Axis-aligned box in inches (on the print area) of a layer, rotation included. */
export function layerBoundsIn(K: KonvaLib, l: Layer): { left: number; top: number; right: number; bottom: number } {
  const { w, h } = layerSizeIn(K, l);
  const a = rad(l.rotation);
  const bw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
  const bh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
  return { left: l.x - bw / 2, top: l.y - bh / 2, right: l.x + bw / 2, bottom: l.y + bh / 2 };
}

export interface RectIn { left: number; top: number; w: number; h: number }
/** Union of all visible layers clipped to the print area, in inches. Null when nothing visible lies inside. */
export function designBounds(K: KonvaLib, layers: Layer[], area: { w: number; h: number }): RectIn | null {
  let l0 = Infinity; let t0 = Infinity; let r0 = -Infinity; let b0 = -Infinity;
  for (const l of layers) {
    if (!l.visible || l.opacity <= 0.01) continue;
    const b = layerBoundsIn(K, l);
    l0 = Math.min(l0, b.left); t0 = Math.min(t0, b.top); r0 = Math.max(r0, b.right); b0 = Math.max(b0, b.bottom);
  }
  if (!Number.isFinite(l0)) return null;
  const left = Math.max(0, l0); const top = Math.max(0, t0);
  const right = Math.min(area.w, r0); const bottom = Math.min(area.h, b0);
  if (right - left < 0.05 || bottom - top < 0.05) return null;
  return { left, top, w: right - left, h: bottom - top };
}

/** Real DPI of a picture as placed (source pixels / inches). */
export const dpiOf = (l: ImageLayer): number => (l.w > 0 ? Math.round(l.pxW / l.w) : 0);

/* ── nodes ────────────────────────────────────────────────────────────── */
export function createNode(K: KonvaLib, l: Layer): Konva.Image | Konva.Text {
  return l.type === 'image' ? new K.Image({ image: undefined, listening: true }) : new K.Text({ listening: true });
}

/** Puts a layer onto its Konva node. World position = (ox + x * P, oy + y * P); node origin is the layer centre. */
export function applyLayer(node: Konva.Image | Konva.Text, l: Layer, P: number, ox: number, oy: number): void {
  let w: number; let h: number;
  if (l.type === 'image') {
    w = l.w * P; h = l.h * P;
    node.setAttrs({ width: w, height: h });
  } else {
    const s = styleText(node as Konva.Text, l, P);
    w = s.w; h = s.h;
  }
  node.setAttrs({
    x: ox + l.x * P, y: oy + l.y * P, offsetX: w / 2, offsetY: h / 2, rotation: l.rotation,
    scaleX: l.flipX ? -1 : 1, scaleY: l.flipY ? -1 : 1, opacity: l.opacity, visible: l.visible, layerId: l.id,
  });
}
