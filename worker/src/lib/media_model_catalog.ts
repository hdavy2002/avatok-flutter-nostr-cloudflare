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
    audio: [
      {
        id: music.model, provider: "Venice", media: "audio", label: "MiniMax Music 2.6",
        supports: ["vocal song", "instrumental", "custom lyrics"],
        // [SONG-LEN-2] MiniMax rejects lyrics_prompt >= 1000 chars (live 400,
        // 2026-08-16), which caps a vocal at roughly 60-90 seconds. Advertise
        // what it can actually deliver so Ava never promises a 3-minute song
        // this model cannot sing.
        durationsSeconds: { min: 60, max: 90 },
        price: { kind: "flat", tokens: cfg.veniceMusicTokens, unit: "per track" },
      },
      ...(String((cfg as any).veniceLongMusicModel ?? "").trim()
        ? [{
            id: String((cfg as any).veniceLongMusicModel).trim(), provider: "Venice", media: "audio" as const,
            label: "Long-form music (2-3.5 min)",
            supports: ["vocal song", "instrumental", "custom lyrics", "long songs"],
            durationsSeconds: { min: 60, max: 210 },
            price: { kind: "flat" as const, tokens: cfg.veniceMusicTokens, unit: "per track" },
          }]
        : []),
    ],
  };
}
