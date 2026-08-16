import type { PlatformConfig } from "../routes/config";
import {
  VENICE_VIDEO_DURATIONS_S,
  veniceRoute,
  type VeniceTier,
} from "./venice";

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

/** One runtime catalog feeds Ava's conversation and server validation. Adding
 * a provider tomorrow means adding one capability record, not new dialogue. */
export function mediaModelCatalog(cfg: PlatformConfig, tier: VeniceTier): {
  video: MediaModelChoice[];
  audio: MediaModelChoice[];
} {
  const t2v = veniceRoute("video_t2v", tier);
  const i2v = veniceRoute("video_i2v", tier);
  const music = veniceRoute("music", tier);
  const videoDurations = VENICE_VIDEO_DURATIONS_S.filter((n) => n >= 8 && n <= 15);
  return {
    video: [
      {
        id: t2v.model, provider: "Venice", media: "video", label: "LTX Fast text-to-video",
        supports: ["text-to-video", "vertical video", "horizontal video"],
        durationsSeconds: [...videoDurations], resolutions: ["1080p", "1440p", "2160p"],
        aspectRatios: ["9:16", "16:9"],
        price: { kind: "flat", tokens: cfg.veniceVideoTokens, unit: "per clip" },
      },
      ...(i2v.model === t2v.model ? [] : [{
        id: i2v.model, provider: "Venice", media: "video" as const, label: "LTX Fast image-to-video",
        supports: ["animate an existing image", "vertical video", "horizontal video"],
        durationsSeconds: [...videoDurations], resolutions: ["1080p", "1440p", "2160p"],
        aspectRatios: ["9:16", "16:9"],
        price: { kind: "flat" as const, tokens: cfg.veniceVideoTokens, unit: "per clip" },
      }]),
    ],
    audio: [{
      id: music.model, provider: "Venice", media: "audio", label: "MiniMax Music 2.6",
      supports: ["vocal song", "instrumental", "custom lyrics"],
      durationsSeconds: { min: 60, max: 210 },
      price: { kind: "flat", tokens: cfg.veniceMusicTokens, unit: "per track" },
    }],
  };
}
