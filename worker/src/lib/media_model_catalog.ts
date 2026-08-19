import type { PlatformConfig } from "../routes/config";

export interface MediaModelChoice {
  id: string;
  provider: string;
  media: "video" | "audio";
  label: string;
  supports: string[];
  durationsSeconds: number[] | { min: number; max: number };
  resolutions?: string[];
  aspectRatios?: string[];
  price: { kind: "flat" | "per_minute"; tokens: number; unit: string };
}

/** Runtime capability catalog for the single Vertex media lane. */
export function mediaModelCatalog(cfg: PlatformConfig, _tier: "free" | "paid"): {
  video: MediaModelChoice[];
  audio: MediaModelChoice[];
} {
  return {
    video: [{
      id: "veo-3.1-generate-preview",
      provider: "Google Vertex",
      media: "video",
      label: "Veo video generation",
      supports: ["text-to-video", "image-to-video", "vertical video", "horizontal video"],
      durationsSeconds: [4, 6, 8],
      resolutions: ["720p", "1080p"],
      aspectRatios: ["9:16", "16:9"],
      price: { kind: "flat", tokens: Number((cfg as any).veniceVideoTokens ?? 0), unit: "per clip" },
    }],
    audio: [{
      id: "lyria-3-pro-preview",
      provider: "Google Vertex",
      media: "audio",
      label: "Lyria 3 Pro music generation",
      supports: ["vocal song", "instrumental", "custom lyrics", "rich instrumentation"],
      durationsSeconds: { min: 30, max: 184 },
      price: { kind: "flat", tokens: Number((cfg as any).veniceMusicTokens ?? 0), unit: "per track" },
    }],
  };
}
