import type { OgRecord } from './types';
import { fontBase64, heroDataUri } from './assets.generated';
import { ogTemplate } from './template';

export function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

/** Isolated runtime adapter: static compiled WASM via Astro's Cloudflare module loader. */
export async function renderOgPng(record: OgRecord, artwork: string = heroDataUri): Promise<Uint8Array> {
  const { ImageResponse } = await import('cf-workers-og/workerd');
  const response = await ImageResponse.create(ogTemplate(record, artwork), {
    width: 1200, height: 630, format: 'png',
    fonts: [{ name: 'Comfortaa', data: decodeBase64(fontBase64), weight: 700, style: 'normal' }],
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!isOgPng(bytes)) throw new Error('OG renderer returned an invalid raster');
  return bytes;
}

export function isOgPng(bytes: Uint8Array): boolean {
  if (bytes.length < 24 || ![137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(16) === 1200 && view.getUint32(20) === 630;
}
