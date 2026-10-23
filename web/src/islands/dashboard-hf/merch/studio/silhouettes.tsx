/* [HF-MERCH-STUDIO-2] Product silhouettes for the merch studio, the product cards and the mockups.
 * Every family is drawn on a 1000 x 1000 viewBox (front view). `silhouette(family, side)` gives the fill path, line details and the print-area box
 * (fractions of the viewBox). `printAreaPx()` fits the REAL inch aspect ratio of the catalogue print area inside that box.
 * Detail strings: plain = thin seam line, '~' prefix = soft shaded shape, '=' prefix = thick line (straps, drawstrings). */
import { useId } from 'react';
import { luminance } from '../../../../lib/studioGeometry';
import type { CatalogItem } from '../api';
import type { Family, Side } from './types';

export interface Box { x: number; y: number; w: number; h: number }
export interface Silhouette { path: string; details: string[]; area: Box }

export const FAMILIES: Family[] = [
  'tee', 'tee_long', 'vneck', 'polo', 'crop_top', 'hoodie', 'crop_hoodie', 'sweatshirt', 'jacket', 'joggers', 'shorts',
  'tote', 'mug', 'bottle', 'phone_case', 'poster', 'notebook', 'popsocket', 'mousepad', 'mask', 'cap', 'other',
];
export const isFamily = (s: unknown): s is Family => typeof s === 'string' && (FAMILIES as string[]).includes(s);

/** The silhouette family of a catalogue item (server `family`, else a guess from kind / name). */
export function familyOf(item: CatalogItem): Family {
  if (isFamily(item.family)) return item.family;
  const n = `${item.kind ?? ''} ${item.name ?? ''}`.toLowerCase();
  const has = (...w: string[]) => w.some(x => n.includes(x));
  if (has('crop') && has('hood')) return 'crop_hoodie';
  if (has('hood')) return 'hoodie';
  if (has('crop')) return 'crop_top';
  if (has('sweat')) return 'sweatshirt';
  if (has('jacket', 'bomber', 'windbreaker')) return 'jacket';
  if (has('jogger', 'pant', 'trouser', 'lower')) return 'joggers';
  if (has('short')) return 'shorts';
  if (has('polo')) return 'polo';
  if (has('v-neck', 'vneck', 'v neck')) return 'vneck';
  if (has('long sleeve', 'full sleeve')) return 'tee_long';
  if (has('tote', 'bag')) return 'tote';
  if (has('mug', 'cup')) return 'mug';
  if (has('bottle', 'tumbler', 'flask')) return 'bottle';
  if (has('phone', 'case', 'cover')) return 'phone_case';
  if (has('poster', 'frame', 'canvas')) return 'poster';
  if (has('note', 'diary', 'journal')) return 'notebook';
  if (has('pop', 'socket', 'grip')) return 'popsocket';
  if (has('mouse', 'desk')) return 'mousepad';
  if (has('mask')) return 'mask';
  if (has('cap', 'hat')) return 'cap';
  if (has('shirt', 'tee', 't-shirt', 'tshirt')) return 'tee';
  return 'other';
}

/* ── garments ─────────────────────────────────────────────────────────── */
/** All x values are half-widths from the centre line (500); the left side is mirrored to the right. */
interface G { nh: number; ntop: number; sx: number; sy: number; ox: number; oy: number; ex: number; ey: number; bh: number; ay: number; hy: number; dipF: number; dipB: number; vneck?: boolean; hood?: boolean }
const f = (n: number): string => String(Math.round(n * 10) / 10);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const Lp = (h: number, y: number): string => `${f(500 - h)} ${f(y)}`;
const Rp = (h: number, y: number): string => `${f(500 + h)} ${f(y)}`;

const TEE: G = { nh: 105, ntop: 118, sx: 255, sy: 150, ox: 410, oy: 265, ex: 335, ey: 395, bh: 245, ay: 345, hy: 880, dipF: 62, dipB: 20 };
const GARMENTS: Partial<Record<Family, G>> = {
  tee: TEE,
  tee_long: { ...TEE, ox: 430, oy: 700, ex: 335, ey: 735, ay: 350 },
  vneck: { ...TEE, dipF: 150, vneck: true },
  polo: { ...TEE, dipF: 40, nh: 98 },
  crop_top: { ...TEE, hy: 640, bh: 238 },
  hoodie: { nh: 118, ntop: 175, sx: 262, sy: 215, ox: 440, oy: 730, ex: 345, ey: 765, bh: 250, ay: 410, hy: 915, dipF: 50, dipB: 30, hood: true },
  crop_hoodie: { nh: 118, ntop: 175, sx: 262, sy: 215, ox: 440, oy: 700, ex: 345, ey: 735, bh: 250, ay: 410, hy: 720, dipF: 50, dipB: 30, hood: true },
  sweatshirt: { nh: 112, ntop: 135, sx: 258, sy: 172, ox: 435, oy: 730, ex: 340, ey: 765, bh: 248, ay: 380, hy: 890, dipF: 52, dipB: 24 },
  jacket: { nh: 104, ntop: 120, sx: 262, sy: 160, ox: 440, oy: 730, ex: 342, ey: 765, bh: 252, ay: 385, hy: 895, dipF: 10, dipB: 10 },
};

function garmentPath(g: G, side: Side): string {
  const dip = side === 'front' ? g.dipF : g.dipB;
  let neck: string;
  if (g.hood) {
    const top = g.ntop - 158;
    neck = `C ${f(500 + g.nh + 95)} ${f(g.ntop - 10)} ${f(500 + g.nh + 92)} ${f(top)} 500 ${f(top)} C ${f(500 - g.nh - 92)} ${f(top)} ${f(500 - g.nh - 95)} ${f(g.ntop - 10)} ${Lp(g.nh, g.ntop)}`;
  } else if (g.vneck && side === 'front') neck = `L 500 ${f(g.ntop + dip)} L ${Lp(g.nh, g.ntop)}`;
  else neck = `C ${f(500 + g.nh * 0.85)} ${f(g.ntop + dip)} ${f(500 - g.nh * 0.85)} ${f(g.ntop + dip)} ${Lp(g.nh, g.ntop)}`;
  return `M ${Lp(g.nh, g.ntop)} L ${Lp(g.sx, g.sy)} L ${Lp(g.ox, g.oy)} L ${Lp(g.ex, g.ey)} L ${Lp(g.bh, g.ay)} L ${Lp(g.bh, g.hy)} L ${Rp(g.bh, g.hy)} L ${Rp(g.bh, g.ay)} L ${Rp(g.ex, g.ey)} L ${Rp(g.ox, g.oy)} L ${Rp(g.sx, g.sy)} L ${Rp(g.nh, g.ntop)} ${neck} Z`;
}

function garmentDetails(fam: Family, g: G, side: Side): string[] {
  const d: string[] = [];
  const long = g.oy > 600;
  // underarm seams
  d.push(`M ${Lp(g.sx, g.sy)} Q ${Lp(g.bh + 16, (g.sy + g.ay) / 2)} ${Lp(g.bh, g.ay)}`);
  d.push(`M ${Rp(g.sx, g.sy)} Q ${Rp(g.bh + 16, (g.sy + g.ay) / 2)} ${Rp(g.bh, g.ay)}`);
  // cuffs
  const cl = long ? 0.1 : 0.14;
  const c1 = [lerp(g.ox, g.sx, cl), lerp(g.oy, g.sy, cl)]; const c2 = [lerp(g.ex, g.bh, cl), lerp(g.ey, g.ay, cl)];
  d.push(`M ${Lp(c1[0], c1[1])} L ${Lp(c2[0], c2[1])}`);
  d.push(`M ${Rp(c1[0], c1[1])} L ${Rp(c2[0], c2[1])}`);
  // hem
  d.push(`M ${Lp(g.bh, g.hy - 36)} L ${Rp(g.bh, g.hy - 36)}`);
  // collar / neck
  const dip = side === 'front' ? g.dipF : g.dipB;
  if (g.hood) {
    if (side === 'front') {
      d.push(`~M ${Lp(g.nh - 4, g.ntop + 6)} C ${f(500 - g.nh)} ${f(g.ntop + 112)} ${f(500 + g.nh)} ${f(g.ntop + 112)} ${Rp(g.nh - 4, g.ntop + 6)} C ${f(500 + g.nh * 0.6)} ${f(g.ntop - 78)} ${f(500 - g.nh * 0.6)} ${f(g.ntop - 78)} ${Lp(g.nh - 4, g.ntop + 6)} Z`);
      d.push(`M ${Lp(g.nh + 22, g.ntop - 4)} C ${f(500 - g.nh * 0.5)} ${f(g.ntop + 150)} ${f(500 + g.nh * 0.5)} ${f(g.ntop + 150)} ${Rp(g.nh + 22, g.ntop - 4)}`);
      d.push(`=M 438 ${f(g.ntop + 100)} L 432 ${f(g.ntop + 235)}`, `=M 562 ${f(g.ntop + 100)} L 568 ${f(g.ntop + 235)}`);
      d.push(`M 336 ${f(g.hy - 285)} L 664 ${f(g.hy - 285)} L 706 ${f(g.hy - 128)} L 294 ${f(g.hy - 128)} Z`);
      d.push(`M 372 ${f(g.hy - 285)} L 340 ${f(g.hy - 128)}`, `M 628 ${f(g.hy - 285)} L 660 ${f(g.hy - 128)}`);
    } else {
      d.push(`M 500 ${f(g.ntop - 158)} C 470 ${f(g.ntop - 60)} 468 ${f(g.ntop + 20)} 480 ${f(g.ntop + 60)}`, `M 500 ${f(g.ntop - 158)} C 530 ${f(g.ntop - 60)} 532 ${f(g.ntop + 20)} 520 ${f(g.ntop + 60)}`);
      d.push(`M ${Lp(g.nh + 18, g.ntop + 4)} C ${f(500 - g.nh * 0.5)} ${f(g.ntop + 52)} ${f(500 + g.nh * 0.5)} ${f(g.ntop + 52)} ${Rp(g.nh + 18, g.ntop + 4)}`);
    }
  } else if (side === 'back') {
    d.push(`M ${Lp(g.nh + 10, g.ntop + 8)} C ${f(500 - g.nh * 0.5)} ${f(g.ntop + dip + 24)} ${f(500 + g.nh * 0.5)} ${f(g.ntop + dip + 24)} ${Rp(g.nh + 10, g.ntop + 8)}`);
  } else if (fam === 'vneck') {
    d.push(`M ${Lp(g.nh + 14, g.ntop + 10)} L 500 ${f(g.ntop + dip + 30)} L ${Rp(g.nh + 14, g.ntop + 10)}`);
  } else if (fam === 'polo') {
    d.push(`~M ${Lp(g.nh + 4, g.ntop - 2)} L ${Lp(g.nh + 48, g.ntop + 74)} L 488 ${f(g.ntop + 150)} L 500 ${f(g.ntop + 52)} Z`);
    d.push(`~M ${Rp(g.nh + 4, g.ntop - 2)} L ${Rp(g.nh + 48, g.ntop + 74)} L 512 ${f(g.ntop + 150)} L 500 ${f(g.ntop + 52)} Z`);
    d.push(`M 500 ${f(g.ntop + 52)} L 500 ${f(g.ntop + 300)}`, `M 534 ${f(g.ntop + 56)} L 534 ${f(g.ntop + 300)}`, `M 466 ${f(g.ntop + 56)} L 466 ${f(g.ntop + 300)}`);
    for (const y of [g.ntop + 110, g.ntop + 190, g.ntop + 270]) d.push(`M 508 ${f(y)} a 8 8 0 1 0 -16 0 a 8 8 0 1 0 16 0`);
  } else if (fam === 'jacket') {
    d.push(`~M ${Lp(g.nh + 8, g.ntop - 6)} L ${Lp(g.nh + 40, g.ntop + 70)} L 490 ${f(g.ntop + 90)} L 490 ${f(g.ntop + 8)} Z`);
    d.push(`~M ${Rp(g.nh + 8, g.ntop - 6)} L ${Rp(g.nh + 40, g.ntop + 70)} L 510 ${f(g.ntop + 90)} L 510 ${f(g.ntop + 8)} Z`);
    d.push(`=M 500 ${f(g.ntop + 8)} L 500 ${f(g.hy)}`);
    d.push(`M 330 ${f(g.hy - 300)} L 440 ${f(g.hy - 262)}`, `M 670 ${f(g.hy - 300)} L 560 ${f(g.hy - 262)}`);
    d.push(`M 330 ${f(g.hy - 300)} L 318 ${f(g.hy - 170)}`, `M 670 ${f(g.hy - 300)} L 682 ${f(g.hy - 170)}`);
  } else {
    // crew neck: rib band
    d.push(`M ${Lp(g.nh + 12, g.ntop + 6)} C ${f(500 - g.nh * 0.8)} ${f(g.ntop + dip + 34)} ${f(500 + g.nh * 0.8)} ${f(g.ntop + dip + 34)} ${Rp(g.nh + 12, g.ntop + 6)}`);
  }
  if (fam === 'sweatshirt') d.push(`M ${Lp(g.bh, g.hy - 70)} L ${Rp(g.bh, g.hy - 70)}`);
  return d;
}

/* ── other products ───────────────────────────────────────────────────── */
const rr = (x: number, y: number, w: number, h: number, r: number): string =>
  `M ${f(x + r)} ${f(y)} L ${f(x + w - r)} ${f(y)} Q ${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + r)} L ${f(x + w)} ${f(y + h - r)} Q ${f(x + w)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)} L ${f(x + r)} ${f(y + h)} Q ${f(x)} ${f(y + h)} ${f(x)} ${f(y + h - r)} L ${f(x)} ${f(y + r)} Q ${f(x)} ${f(y)} ${f(x + r)} ${f(y)} Z`;
const circ = (cx: number, cy: number, r: number): string => `M ${f(cx + r)} ${f(cy)} a ${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0 a ${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0`;

const GARMENT_AREA: Partial<Record<Family, { front: Box; back: Box }>> = {
  tee: { front: { x: 0.31, y: 0.25, w: 0.38, h: 0.5 }, back: { x: 0.3, y: 0.2, w: 0.4, h: 0.56 } },
  tee_long: { front: { x: 0.31, y: 0.25, w: 0.38, h: 0.5 }, back: { x: 0.3, y: 0.2, w: 0.4, h: 0.56 } },
  vneck: { front: { x: 0.31, y: 0.3, w: 0.38, h: 0.44 }, back: { x: 0.3, y: 0.2, w: 0.4, h: 0.56 } },
  polo: { front: { x: 0.33, y: 0.4, w: 0.34, h: 0.34 }, back: { x: 0.3, y: 0.2, w: 0.4, h: 0.56 } },
  crop_top: { front: { x: 0.31, y: 0.25, w: 0.38, h: 0.34 }, back: { x: 0.3, y: 0.2, w: 0.4, h: 0.4 } },
  hoodie: { front: { x: 0.31, y: 0.37, w: 0.38, h: 0.32 }, back: { x: 0.3, y: 0.28, w: 0.4, h: 0.52 } },
  crop_hoodie: { front: { x: 0.31, y: 0.37, w: 0.38, h: 0.26 }, back: { x: 0.3, y: 0.28, w: 0.4, h: 0.36 } },
  sweatshirt: { front: { x: 0.31, y: 0.3, w: 0.38, h: 0.46 }, back: { x: 0.3, y: 0.22, w: 0.4, h: 0.56 } },
  jacket: { front: { x: 0.54, y: 0.36, w: 0.14, h: 0.14 }, back: { x: 0.3, y: 0.22, w: 0.4, h: 0.56 } },
};

function build(family: Family, side: Side): Silhouette {
  const g = GARMENTS[family];
  if (g) {
    const areas = GARMENT_AREA[family] ?? GARMENT_AREA.tee!;
    return { path: garmentPath(g, side), details: garmentDetails(family, g, side), area: side === 'front' ? areas.front : areas.back };
  }
  switch (family) {
    case 'joggers':
      return {
        path: 'M 285 100 L 715 100 L 758 380 L 706 905 L 548 905 L 500 430 L 452 905 L 294 905 L 242 380 Z',
        details: ['M 270 168 L 730 168', '=M 470 168 L 462 250', '=M 530 168 L 538 250', 'M 500 430 L 500 168', 'M 706 840 L 548 840', 'M 294 840 L 452 840', 'M 300 250 C 330 300 330 360 300 400', 'M 700 250 C 670 300 670 360 700 400'],
        area: side === 'front' ? { x: 0.54, y: 0.3, w: 0.2, h: 0.3 } : { x: 0.3, y: 0.24, w: 0.4, h: 0.3 },
      };
    case 'shorts':
      return {
        path: 'M 262 190 L 738 190 L 800 700 L 548 722 L 500 450 L 452 722 L 200 700 Z',
        details: ['M 255 260 L 745 260', '=M 470 260 L 462 340', '=M 530 260 L 538 340', 'M 500 450 L 500 260', 'M 810 640 L 548 664', 'M 190 640 L 452 664'],
        area: side === 'front' ? { x: 0.56, y: 0.32, w: 0.18, h: 0.26 } : { x: 0.3, y: 0.3, w: 0.4, h: 0.26 },
      };
    case 'tote':
      return {
        path: `${rr(185, 335, 630, 570, 24)} M 330 335 C 322 90 678 90 670 335 L 640 335 C 646 160 354 160 360 335 Z`,
        details: ['M 190 400 L 810 400', 'M 330 335 C 322 90 678 90 670 335 L 640 335 C 646 160 354 160 360 335 Z'],
        area: { x: 0.3, y: 0.46, w: 0.4, h: 0.4 },
      };
    case 'mug':
      return {
        path: 'M 215 235 L 715 235 L 705 815 Q 703 862 656 862 L 274 862 Q 227 862 225 815 Z M 712 320 C 960 300 970 770 700 770 L 702 696 C 850 700 840 392 714 392 Z',
        details: ['M 215 235 Q 465 292 715 235', 'M 225 815 Q 465 880 705 815', 'M 255 300 L 262 780'],
        area: { x: 0.24, y: 0.34, w: 0.46, h: 0.44 },
      };
    case 'bottle':
      return {
        path: 'M 425 52 L 575 52 Q 590 52 590 68 L 590 150 L 598 192 C 660 232 702 272 702 345 L 702 905 Q 702 950 656 950 L 344 950 Q 298 950 298 905 L 298 345 C 298 272 340 232 402 192 L 410 150 L 410 68 Q 410 52 425 52 Z',
        details: ['M 410 150 L 590 150', 'M 410 108 L 590 108', 'M 402 192 L 598 192', 'M 330 360 L 332 900', 'M 298 330 Q 500 380 702 330'],
        area: { x: 0.35, y: 0.42, w: 0.3, h: 0.38 },
      };
    case 'phone_case':
      return {
        path: rr(290, 50, 420, 900, 96),
        details: [rr(310, 70, 380, 860, 80), `~${rr(335, 95, 140, 150, 34)}`, circ(380, 140, 26), circ(430, 200, 26), circ(445, 128, 14)],
        area: { x: 0.31, y: 0.29, w: 0.38, h: 0.62 },
      };
    case 'poster':
      return {
        path: rr(160, 70, 680, 860, 12),
        details: [rr(200, 110, 600, 780, 4), rr(262, 172, 476, 656, 2), '~M 262 172 L 738 172 L 738 828 L 262 828 Z'],
        area: { x: 0.28, y: 0.19, w: 0.44, h: 0.62 },
      };
    case 'notebook':
      return {
        path: rr(230, 70, 590, 860, 30),
        details: [rr(260, 100, 530, 800, 18), 'M 300 70 L 300 930', ...[160, 240, 320, 400, 480, 560, 640, 720, 800, 880].map(y => circ(262, y, 14))],
        area: { x: 0.33, y: 0.18, w: 0.44, h: 0.64 },
      };
    case 'popsocket':
      return {
        path: circ(500, 500, 330),
        details: [circ(500, 500, 296), '~' + circ(500, 500, 110), circ(500, 500, 70), 'M 300 330 Q 340 270 420 240'],
        area: { x: 0.28, y: 0.28, w: 0.44, h: 0.44 },
      };
    case 'mousepad':
      return {
        path: rr(110, 240, 780, 520, 70),
        details: [rr(130, 260, 740, 480, 56), 'M 180 300 Q 330 280 460 300'],
        area: { x: 0.15, y: 0.31, w: 0.7, h: 0.38 },
      };
    case 'mask':
      return {
        path: 'M 235 335 C 400 280 600 280 765 335 L 738 645 C 600 718 400 718 262 645 Z',
        details: ['M 235 335 C 130 350 110 520 205 600', 'M 765 335 C 870 350 890 520 795 600', 'M 250 420 Q 500 460 750 420', 'M 256 500 Q 500 540 744 500', 'M 262 580 Q 500 620 738 580'],
        area: { x: 0.3, y: 0.42, w: 0.4, h: 0.2 },
      };
    case 'cap':
      return {
        path: 'M 200 575 C 185 320 330 195 500 195 C 670 195 815 320 800 575 C 650 540 350 540 200 575 Z M 130 585 C 130 560 870 560 870 585 C 870 705 130 705 130 585 Z',
        details: [circ(500, 205, 22), 'M 500 195 L 500 565', 'M 350 240 C 330 330 330 450 340 555', 'M 650 240 C 670 330 670 450 660 555', 'M 135 600 C 400 640 600 640 865 600'],
        area: { x: 0.36, y: 0.3, w: 0.28, h: 0.22 },
      };
    default:
      return { path: rr(150, 150, 700, 700, 70), details: [rr(176, 176, 648, 648, 52)], area: { x: 0.22, y: 0.22, w: 0.56, h: 0.56 } };
  }
}

const cache = new Map<string, Silhouette>();
/** Path, line details and print-area box (fractions of the 1000 x 1000 viewBox) for a family and side. */
export function silhouette(family: Family | string, side: Side = 'front'): Silhouette {
  const fam: Family = isFamily(family) ? family : 'other';
  const key = `${fam}:${side}`;
  let s = cache.get(key);
  if (!s) { s = build(fam, side); cache.set(key, s); }
  return s;
}

/** The print area on the 1000 x 1000 stage in px, with the real inch aspect ratio fitted inside the family's box (centred). `ppi` = stage px per inch. */
export function printAreaPx(family: Family | string, side: Side, areaIn: { w: number; h: number }): { x: number; y: number; w: number; h: number; ppi: number } {
  const b = silhouette(family, side).area;
  const bw = b.w * 1000; const bh = b.h * 1000;
  const aw = Math.max(0.1, areaIn.w); const ah = Math.max(0.1, areaIn.h);
  const ppi = Math.min(bw / aw, bh / ah);
  const w = aw * ppi; const h = ah * ppi;
  return { x: b.x * 1000 + (bw - w) / 2, y: b.y * 1000 + (bh - h) / 2, w, h, ppi };
}

/* ── SVG output ───────────────────────────────────────────────────────── */
const safeHex = (hex: string): string => (/^#[0-9a-f]{3,8}$/i.test(hex.trim()) ? hex.trim() : '#e8e0d4');

/** Inner SVG markup (no <svg> wrapper). `uid` keeps gradient ids unique when several silhouettes sit on one page. */
export function silhouetteInner(family: Family | string, side: Side, hex: string, uid: string): string {
  const s = silhouette(family, side);
  const fill = safeHex(hex);
  const dark = luminance(fill) < 0.28;
  const line = dark ? 'rgba(255,255,255,0.24)' : 'rgba(0,0,0,0.22)';
  const shade = dark ? 'rgba(0,0,0,0.38)' : 'rgba(0,0,0,0.10)';
  const out = dark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.34)';
  const gid = `g${uid}`;
  const det = s.details.map(d => {
    if (d.startsWith('~')) return `<path d="${d.slice(1)}" fill="${shade}" stroke="${line}" stroke-width="3" stroke-linejoin="round"/>`;
    if (d.startsWith('=')) return `<path d="${d.slice(1)}" fill="none" stroke="${line}" stroke-width="11" stroke-linecap="round"/>`;
    return `<path d="${d}" fill="none" stroke="${line}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  return `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.2"/><stop offset="0.55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.14"/></linearGradient></defs>`
    + `<path d="${s.path}" fill="${fill}"/><path d="${s.path}" fill="url(#${gid})"/>${det}`
    + `<path d="${s.path}" fill="none" stroke="${out}" stroke-width="5" stroke-linejoin="round"/>`;
}

/** A full standalone SVG document string (for drawing the product on a canvas). */
export function silhouetteSvg(family: Family | string, side: Side, hex: string, uid = 'x'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000" height="1000">${silhouetteInner(family, side, hex, uid)}</svg>`;
}
export const silhouetteDataUrl = (family: Family | string, side: Side, hex: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(silhouetteSvg(family, side, hex))}`;

/** A clean front-view product drawing, filled with `hex`. `size` = width and height in px. */
export function ProductSilhouette({ family, hex, size, side = 'front', className }: { family: Family | string; hex: string; size: number; side?: Side; className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  return <svg className={className} width={size} height={size} viewBox="0 0 1000 1000" role="img" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={{ __html: silhouetteInner(family, side, hex, uid) }} />;
}
