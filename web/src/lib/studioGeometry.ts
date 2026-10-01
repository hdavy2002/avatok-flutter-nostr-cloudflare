// [AUMFE-POD-STUDIO-WEB-1 2026-10-01] Shared geometry of the Studio editor and the plain-shirt pictures.
// Ported from Specs/studio-mockup/Editor.dc.html (script block): one shirt silhouette, 20 px per inch,
// the print area drawn at the same top/centre for every product. The editor (SVG + divs), printFile.ts
// (300 DPI clip) and composite.ts (plain-shirt pictures) all read THIS file, so what the owner sees in the
// editor is exactly what is printed and what is shown in the plain-shirt picture.
// No DOM here: pure maths, safe to import anywhere.

export type FrameShape = 'none' | 'rect' | 'square' | 'circle';
export type PrintSide = 'front' | 'back';

/** Pixels per inch on the editor stage (mockup `P`). */
export const STAGE_PX_PER_IN = 20;
export const STAGE_W = 620;
export const STAGE_H = 680;
/** Top of the print area on the stage (mockup: 120). The area is centred on x = 310. */
export const AREA_TOP_PX = 120;
export const STAGE_CENTRE_X = 310;
/** Printrove minimum is 300 DPI; export is capped at 5000 px per side. */
export const EXPORT_DPI = 300;
export const EXPORT_MAX_PX = 5000;
/** Frame shape of 'rect' is 1.25 × as tall as it is wide (mockup). */
export const RECT_RATIO = 1.25;

/** The mockup's shirt silhouette and neckline, verbatim. */
export const SHIRT_PATH = 'M220 40 L160 58 L12 150 L62 262 L90 248 L90 660 L530 660 L530 248 L558 262 L608 150 L460 58 L400 40 C385 84 345 102 310 102 C275 102 235 84 220 40 Z';
export const NECK_PATH = 'M220 40 C235 84 275 102 310 102 C345 102 385 84 400 40';

export interface AreaIn { w: number; h: number }

/** Pixel rectangle of the print area on the stage. */
export function areaRectPx(area: AreaIn): { left: number; top: number; w: number; h: number } {
  const w = area.w * STAGE_PX_PER_IN;
  return { left: STAGE_CENTRE_X - w / 2, top: AREA_TOP_PX, w, h: area.h * STAGE_PX_PER_IN };
}

/** What the owner controls in the editor (nudge in inches; the mockup's ½-inch step is 0.5). */
export interface EditorState {
  shape: FrameShape;
  /** Frame width in inches (the slider). Ignored for 'none'. */
  frame: number;
  zoom: number;
  nudgeX: number;
  nudgeY: number;
  /** Frame top, inches below the top of the print area. */
  top: number;
}

export interface Layout {
  /** Frame size and position, inches, relative to the print area's top-left. */
  frameW: number; frameH: number; frameLeft: number; frameTop: number;
  /** Artwork size, inches, and its offset INSIDE the frame (may be negative). */
  artW: number; artH: number; artLeft: number; artTop: number;
  /** Visible part of the art inside the frame (rectangle bounds), inches, relative to the frame. */
  visX: number; visY: number; visW: number; visH: number;
  /** Real DPI of the art as placed (source pixels / inches). */
  dpi: number;
  /** True when no art lands inside the frame. */
  empty: boolean;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;

/** Port of the mockup's `renderVals` maths, generalised to non-square art. */
export function computeLayout(s: EditorState, art: { w: number; h: number }, area: AreaIn): Layout {
  let frameW: number; let frameH: number;
  const wanted = Math.min(Math.max(s.frame, 1), area.w);
  if (s.shape === 'none') { frameW = area.w; frameH = area.h; }
  else if (s.shape === 'rect') { frameW = wanted; frameH = Math.min(area.h, r1(wanted * RECT_RATIO)); }
  else { frameW = Math.min(wanted, area.h); frameH = frameW; }
  const frameTop = s.shape === 'none' ? 0 : Math.max(0, Math.min(area.h - frameH, s.top));
  const frameLeft = (area.w - frameW) / 2;
  const artW = (frameW * s.zoom) / 100;
  const artH = art.w > 0 ? (artW * art.h) / art.w : artW;
  const artLeft = (frameW - artW) / 2 + s.nudgeX;
  const artTop = (frameH - artH) / 2 + s.nudgeY;
  const x0 = Math.max(0, artLeft); const y0 = Math.max(0, artTop);
  const x1 = Math.min(frameW, artLeft + artW); const y1 = Math.min(frameH, artTop + artH);
  const visW = Math.max(0, x1 - x0); const visH = Math.max(0, y1 - y0);
  return {
    frameW, frameH, frameLeft, frameTop, artW, artH, artLeft, artTop,
    visX: x0, visY: y0, visW, visH,
    dpi: artW > 0 ? Math.round(art.w / artW) : 0,
    empty: visW < 0.05 || visH < 0.05,
  };
}

export type DpiTone = 'ok' | 'info' | 'warn' | 'bad';
/** Mockup chip rules: ≥300 Sharp, 200–299 Good, 150–199 OK, <150 blocks "Looks good". */
export function dpiQuality(dpi: number): { tone: DpiTone; text: string; blocks: boolean } {
  if (dpi >= 300) return { tone: 'ok', text: 'Sharp', blocks: false };
  if (dpi >= 200) return { tone: 'info', text: 'Good', blocks: false };
  if (dpi >= 150) return { tone: 'warn', text: 'OK — slightly soft', blocks: false };
  return { tone: 'bad', text: 'Too blurry to print', blocks: true };
}

/** Where the exported print file sits on the print area (inches from its top-left). */
export function printRectIn(l: Layout): { left: number; top: number; w: number; h: number } {
  return { left: l.frameLeft + l.visX, top: l.frameTop + l.visY, w: l.visW, h: l.visH };
}

/** Saved placement (spec §4) plus the two offsets this client adds so a print file can be put back exactly. */
export interface SavedPlacement {
  kind: string; side: PrintSide; shape: FrameShape;
  frame_w_in: number; frame_h_in: number; frame_top_in: number;
  zoom_pct: number; nudge_x_in: number; nudge_y_in: number;
  print_w_in: number; print_h_in: number; dpi: number;
  /** Extra (client-added): top-left of the print file on the print area. */
  print_left_in?: number; print_top_in?: number;
}

export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
export const isLightColour = (hex: string): boolean => luminance(hex) > 0.8;
