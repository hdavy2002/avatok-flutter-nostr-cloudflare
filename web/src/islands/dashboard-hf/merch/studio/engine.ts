/* [HF-MERCH-STUDIO-2] The imperative Konva stage of the studio. React owns the `layers` array; this class draws it, handles drag / resize / rotate on the
 * stage and reports finished gestures back through callbacks. World = the 1000 x 1000 silhouette space; layer inches map to world px via `geom.ppi`. */
import type Konva from 'konva';
import { luminance } from '../../../../lib/studioGeometry';
import { loadMerchFont } from './fonts';
import { applyLayer, createNode, loadImage, markFontReady, type KonvaLib } from './nodes';
import { printAreaPx, silhouetteDataUrl } from './silhouettes';
import type { Layer, Side } from './types';

export interface EngineCallbacks {
  /** `fromStage` = the owner tapped it on the canvas (so the tool panel can follow). */
  select(id: string | null, fromStage: boolean): void;
  /** A finished drag / resize / rotate. Positions are inches (centre) on the print area. */
  patch(id: string, patch: Record<string, number>): void;
  /** A picture could not be loaded. */
  imageError(id: string, src: string): void;
  fontError(family: string, error: unknown): void;
  /** A font finished loading (text sizes changed, so measurements in React must be redone). */
  fontLoaded(family: string): void;
}
export interface ProductView { family: string; side: Side; hex: string; areaIn: { w: number; h: number } }

interface Entry { node: Konva.Image | Konva.Text; ghost: Konva.Image | Konva.Text; src?: string; font?: string }
const coarse = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const norm360 = (d: number): number => { const r = ((d % 360) + 360) % 360; return Math.round((r > 359.95 ? 0 : r) * 10) / 10; };

export class StudioEngine {
  private stage: Konva.Stage;
  private bgLayer: Konva.Layer; private ghostLayer: Konva.Layer; private mainLayer: Konva.Layer; private uiLayer: Konva.Layer;
  private clip: Konva.Group; private ghostGroup: Konva.Group;
  private product: Konva.Image; private areaRect: Konva.Rect; private guideV: Konva.Line; private guideH: Konva.Line; private tr: Konva.Transformer;
  private entries = new Map<string, Entry>();
  private geom = { x: 0, y: 0, w: 1, h: 1, ppi: 1 };
  private layers: Layer[] = [];
  private selectedId: string | null = null;
  private view = { z: 1, cx: 500, cy: 500 };
  private destroyed = false;
  private prod: ProductView | null = null;

  constructor(private K: KonvaLib, private el: HTMLDivElement, private cb: EngineCallbacks) {
    const w = Math.max(200, el.clientWidth); const h = Math.max(200, el.clientHeight);
    this.stage = new K.Stage({ container: el, width: w, height: h });
    this.bgLayer = new K.Layer({ listening: false }); this.ghostLayer = new K.Layer({ listening: false, opacity: 0.22 });
    this.mainLayer = new K.Layer(); this.uiLayer = new K.Layer();
    this.stage.add(this.bgLayer, this.ghostLayer, this.mainLayer, this.uiLayer);
    this.product = new K.Image({ image: undefined, x: 0, y: 0, width: 1000, height: 1000, listening: false });
    this.bgLayer.add(this.product);
    this.ghostGroup = new K.Group(); this.ghostLayer.add(this.ghostGroup);
    this.clip = new K.Group(); this.mainLayer.add(this.clip);
    this.areaRect = new K.Rect({ stroke: '#c2185b', strokeWidth: 2.5, dash: [11, 8], strokeScaleEnabled: false, listening: false, cornerRadius: 3 });
    this.guideV = new K.Line({ stroke: '#d81b72', strokeWidth: 1.5, dash: [5, 5], strokeScaleEnabled: false, visible: false, listening: false });
    this.guideH = new K.Line({ stroke: '#d81b72', strokeWidth: 1.5, dash: [5, 5], strokeScaleEnabled: false, visible: false, listening: false });
    const c = coarse();
    this.tr = new K.Transformer({
      rotationSnaps: [0, 90, 180, 270], rotationSnapTolerance: 7, keepRatio: true, flipEnabled: false, ignoreStroke: true,
      enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
      anchorSize: c ? 30 : 17, anchorCornerRadius: c ? 15 : 9, anchorStroke: '#d81b72', anchorFill: '#ffffff', anchorStrokeWidth: 2.5,
      borderStroke: '#d81b72', borderStrokeWidth: 2, rotateAnchorOffset: c ? 44 : 34, padding: 3,
      boundBoxFunc: (oldBox, newBox) => (newBox.width < 10 || newBox.height < 10 ? oldBox : newBox),
    });
    this.uiLayer.add(this.areaRect, this.guideV, this.guideH, this.tr);

    const onDown = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void => {
      const t = e.target;
      if (t.getParent()?.className === 'Transformer' || t.className === 'Transformer') return;
      const id = t === this.stage ? null : (t.getAttr('layerId') as string | undefined) ?? null;
      this.cb.select(id, true);
    };
    this.stage.on('mousedown touchstart', onDown);
    this.stage.on('dragmove', e => { if (e.target === this.stage) this.readPan(); });
    this.applyView();
  }

  /* ── product + area ─────────────────────────────────────────────────── */
  setProduct(p: ProductView): void {
    const same = this.prod && this.prod.family === p.family && this.prod.side === p.side && this.prod.hex === p.hex && this.prod.areaIn.w === p.areaIn.w && this.prod.areaIn.h === p.areaIn.h;
    if (same) return;
    const geomChanged = !this.prod || this.prod.family !== p.family || this.prod.side !== p.side || this.prod.areaIn.w !== p.areaIn.w || this.prod.areaIn.h !== p.areaIn.h;
    this.prod = p;
    const g = printAreaPx(p.family, p.side, p.areaIn);
    this.geom = g;
    this.areaRect.setAttrs({ x: g.x, y: g.y, width: g.w, height: g.h, stroke: luminance(p.hex) > 0.55 ? '#c2185b' : '#fcd34d' });
    this.clip.clip({ x: g.x, y: g.y, width: g.w, height: g.h });
    this.guideV.points([g.x + g.w / 2, g.y - 14, g.x + g.w / 2, g.y + g.h + 14]);
    this.guideH.points([g.x - 14, g.y + g.h / 2, g.x + g.w + 14, g.y + g.h / 2]);
    const url = silhouetteDataUrl(p.family, p.side, p.hex);
    void loadImage(url).then(img => { if (!this.destroyed && this.prod === p) { this.product.image(img); this.bgLayer.batchDraw(); } }).catch(() => this.cb.imageError('product', url));
    if (geomChanged) this.sync(this.layers, this.selectedId);
    this.uiLayer.batchDraw();
  }

  /* ── layers ─────────────────────────────────────────────────────────── */
  sync(layers: Layer[], selectedId: string | null): void {
    if (this.destroyed) return;
    this.layers = layers; this.selectedId = selectedId;
    const seen = new Set<string>();
    layers.forEach((l, i) => {
      seen.add(l.id);
      let e = this.entries.get(l.id);
      if (!e || e.node.className !== (l.type === 'image' ? 'Image' : 'Text')) {
        if (e) { e.node.destroy(); e.ghost.destroy(); }
        e = this.create(l);
        this.entries.set(l.id, e);
      }
      applyLayer(e.node, l, this.geom.ppi, this.geom.x, this.geom.y);
      applyLayer(e.ghost, l, this.geom.ppi, this.geom.x, this.geom.y);
      e.node.draggable(!l.locked && l.visible);
      e.node.listening(!l.locked && l.visible);
      e.ghost.listening(false);
      if (l.type === 'image') {
        if (e.src !== l.src) {
          e.src = l.src;
          const src = l.src; const node = e.node as Konva.Image; const ghost = e.ghost as Konva.Image; const id = l.id;
          void loadImage(src).then(img => {
            if (this.destroyed || this.entries.get(id)?.src !== src) return;
            node.image(img); ghost.image(img); this.mainLayer.batchDraw(); this.ghostLayer.batchDraw();
          }).catch(() => { if (!this.destroyed) this.cb.imageError(id, src); });
        }
      } else if (e.font !== l.font) {
        e.font = l.font;
        const fam = l.font; const id = l.id;
        loadMerchFont(fam).then(() => {
          markFontReady(fam);
          if (!this.destroyed) this.cb.fontLoaded(fam);
          const cur = this.layers.find(x => x.id === id); const en = this.entries.get(id);
          if (this.destroyed || !cur || !en) return;
          applyLayer(en.node, cur, this.geom.ppi, this.geom.x, this.geom.y);
          applyLayer(en.ghost, cur, this.geom.ppi, this.geom.x, this.geom.y);
          this.refreshTransformer(); this.mainLayer.batchDraw(); this.ghostLayer.batchDraw();
        }).catch(err => { if (!this.destroyed) this.cb.fontError(fam, err); });
      }
      e.node.zIndex(i); e.ghost.zIndex(i);
    });
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) { e.node.destroy(); e.ghost.destroy(); this.entries.delete(id); }
    }
    this.refreshTransformer();
    this.mainLayer.batchDraw(); this.ghostLayer.batchDraw();
  }

  private refreshTransformer(): void {
    const l = this.layers.find(x => x.id === this.selectedId);
    const e = l ? this.entries.get(l.id) : undefined;
    this.tr.nodes(l && e && l.visible && !l.locked ? [e.node] : []);
    this.tr.forceUpdate();
    this.uiLayer.batchDraw();
  }

  private create(l: Layer): Entry {
    const node = createNode(this.K, l); const ghost = createNode(this.K, l);
    node.setAttr('layerId', l.id);
    this.clip.add(node); this.ghostGroup.add(ghost);
    const mirror = (): void => { ghost.setAttrs({ x: node.x(), y: node.y(), rotation: node.rotation(), scaleX: node.scaleX(), scaleY: node.scaleY() }); this.ghostLayer.batchDraw(); };
    node.on('dragmove', () => {
      // centre snapping: the layer centre jumps to the print-area centre lines
      const k = this.stage.scaleX(); const thr = 9 / k;
      const cx = this.geom.x + this.geom.w / 2; const cy = this.geom.y + this.geom.h / 2;
      let sv = false; let sh = false;
      if (Math.abs(node.x() - cx) < thr) { node.x(cx); sv = true; }
      if (Math.abs(node.y() - cy) < thr) { node.y(cy); sh = true; }
      this.guideV.visible(sv); this.guideH.visible(sh);
      mirror(); this.uiLayer.batchDraw();
    });
    node.on('transform', mirror);
    node.on('dragend', () => {
      this.guideV.visible(false); this.guideH.visible(false); this.uiLayer.batchDraw();
      this.cb.patch(l.id, { x: (node.x() - this.geom.x) / this.geom.ppi, y: (node.y() - this.geom.y) / this.geom.ppi });
    });
    node.on('transformend', () => {
      const cur = this.layers.find(x => x.id === l.id); if (!cur) return;
      const s = Math.max(Math.abs(node.scaleX()), Math.abs(node.scaleY()));
      const base = { x: (node.x() - this.geom.x) / this.geom.ppi, y: (node.y() - this.geom.y) / this.geom.ppi, rotation: norm360(node.rotation()) };
      if (cur.type === 'image') this.cb.patch(l.id, { ...base, w: cur.w * Math.abs(node.scaleX()), h: cur.h * Math.abs(node.scaleY()) });
      else this.cb.patch(l.id, { ...base, sizeIn: Math.max(0.1, cur.sizeIn * s) });
    });
    node.on('mouseenter', () => { this.el.style.cursor = 'move'; });
    node.on('mouseleave', () => { this.el.style.cursor = ''; });
    return { node, ghost };
  }

  /* ── view ───────────────────────────────────────────────────────────── */
  private applyView(): void {
    const w = this.stage.width(); const h = this.stage.height();
    const base = Math.min(w, h) / 1060;
    const k = base * this.view.z;
    this.stage.scale({ x: k, y: k });
    this.stage.position({ x: w / 2 - this.view.cx * k, y: h / 2 - this.view.cy * k });
    this.stage.draggable(this.view.z > 1.01);
    this.stage.batchDraw();
  }
  private readPan(): void {
    const k = this.stage.scaleX();
    this.view.cx = (this.stage.width() / 2 - this.stage.x()) / k;
    this.view.cy = (this.stage.height() / 2 - this.stage.y()) / k;
  }
  resize(): void {
    if (this.destroyed) return;
    const w = Math.max(160, this.el.clientWidth); const h = Math.max(160, this.el.clientHeight);
    if (w === this.stage.width() && h === this.stage.height()) return;
    this.stage.size({ width: w, height: h });
    this.applyView();
  }
  /** zoom 1 = the whole product fits. */
  setZoom(z: number): void { this.view.z = Math.min(4, Math.max(1, z)); if (this.view.z <= 1.01) { this.view.cx = 500; this.view.cy = 500; } this.applyView(); }
  zoomToArea(): number {
    const g = this.geom;
    const z = Math.min(4, Math.max(1, 1000 / (Math.max(g.w, g.h) * 1.18)));
    this.view = { z, cx: g.x + g.w / 2, cy: g.y + g.h / 2 };
    this.applyView();
    return z;
  }
  get zoom(): number { return this.view.z; }

  destroy(): void {
    this.destroyed = true;
    this.entries.clear();
    this.stage.destroy();
    this.el.style.cursor = '';
  }
}
