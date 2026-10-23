/* [HF-MERCH-STUDIO-2] Shared contract between the wizard (../Wizard.tsx, owned by the flow) and the design studio (./Designer.tsx).
 * Spec: Specs/SPEC-2026-10-23-HF-MERCH-STUDIO-2.md. Inches are measured on the product's print area, top-left origin. */
import type { ArtUpload, CatalogItem, Colour } from '../api';

/** A picture in the influencer's tray (an upload or an AI result). `localUrl` is an object URL of the original bytes when the browser has them. */
export interface StudioArt extends ArtUpload { localUrl?: string; source: 'upload' | 'ai' | 'bg_removed' | 'composite'; label?: string }

export type Side = 'front' | 'back';
export type Family =
  | 'tee' | 'tee_long' | 'vneck' | 'polo' | 'crop_top' | 'hoodie' | 'crop_hoodie' | 'sweatshirt' | 'jacket' | 'joggers' | 'shorts'
  | 'tote' | 'mug' | 'bottle' | 'phone_case' | 'poster' | 'notebook' | 'popsocket' | 'mousepad' | 'mask' | 'cap' | 'other';

interface LayerBase { id: string; name: string; visible: boolean; locked: boolean; x: number; y: number; rotation: number; opacity: number; flipX: boolean; flipY: boolean }
/** x / y = CENTRE of the layer in inches on the print area; w / h = size in inches (before rotation). */
export interface ImageLayer extends LayerBase { type: 'image'; artId: string; src: string; pxW: number; pxH: number; w: number; h: number }
export interface TextLayer extends LayerBase {
  type: 'text'; text: string; font: string; sizeIn: number; fill: string; align: 'left' | 'center' | 'right';
  letterSpacing: number; lineHeight: number; stroke: string | null; strokeIn: number; shadow: boolean; bold: boolean; italic: boolean;
}
export type Layer = ImageLayer | TextLayer;

/** What the studio hands back after "Looks good": the print file is uploaded and the mockups are made. */
export interface DesignResult {
  artId: string; printFileId: string; wIn: number; hIn: number; leftIn: number; topIn: number; dpi: number;
  mockupUrls: string[]; previewUrl: string; layers: Layer[];
}

export interface DesignerProps {
  item: CatalogItem; side: Side; colours: Colour[];
  arts: StudioArt[];
  /** Adds a picture to the tray (the studio's own "Remove background" result, or a composite upload for a text-only design). */
  onArtAdded: (a: StudioArt) => void;
  /** Opens the wizard's upload / AI panel from inside the studio ("Add picture"). */
  onWantMoreArt: () => void;
  initialLayers?: Layer[];
  onLayersChange?: (layers: Layer[]) => void;
  onBack: () => void;
  onDone: (r: DesignResult) => void;
}
