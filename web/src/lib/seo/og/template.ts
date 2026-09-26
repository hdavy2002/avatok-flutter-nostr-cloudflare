import { createElement as h } from 'react';
import type { OgRecord } from './types';

const labels: Record<OgRecord['kind'], string> = {
  home: 'SACRED RITUALS, SHARED LIVE', page: 'SAA THUM', collection: 'EXPLORE SAA THUM',
  article: 'RITUAL STORIES & GUIDES', help: 'HERE TO HELP', listing: 'LIVE RITUALS',
  creator: 'MEET THE ORGANISER', agent: 'EXPLORE SAA THUM',
};

/** Titles are text nodes, never HTML. Hard limits keep pathological records inside the card. */
function copy(value: string | undefined, limit: number): string {
  const text = (value ?? '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit - 3).join('').trimEnd() + '...';
}

/**
 * [OG-AD-HOOK-1 2026-09-26, owner decision] When the record carries an `ad`, the
 * card is an advert, not a repeat of the title: WhatsApp already prints og:title
 * and og:description under the image. One big devotional line, a saffron
 * "Join live · ₹111" pill, and the ritual's own art — larger than on the plain card.
 */
function adTemplate(record: OgRecord, artwork: string, ad: NonNullable<OgRecord['ad']>) {
  const hook = copy(ad.hook, 90);
  const price = copy(ad.price, 16);
  const size = hook.length > 58 ? 50 : hook.length > 40 ? 56 : 62;
  return h('div', { style: {
    width: 1200, height: 630, display: 'flex', position: 'relative', overflow: 'hidden',
    backgroundColor: '#fff8e8', color: '#304d35', fontFamily: 'Comfortaa', fontWeight: 700,
    padding: 40, border: '12px solid #b94427',
  } },
    h('div', { style: { display: 'flex', flexDirection: 'column', width: 600, paddingRight: 34 } },
      h('div', { style: { display: 'flex', fontSize: 40, color: '#ab3421' } }, 'Saa Thum'),
      h('div', { style: { display: 'flex', fontSize: 17, letterSpacing: 2, color: '#9b4b24', marginTop: 12 } }, 'JOIN LIVE, FROM ANYWHERE'),
      h('div', { style: { display: 'flex', flex: 1, alignItems: 'center' } },
        h('div', { style: { display: 'flex', fontSize: size, lineHeight: 1.2, color: '#304d35', maxHeight: 300, overflow: 'hidden' } }, hook),
      ),
      h('div', { style: { display: 'flex', alignItems: 'center' } },
        h('div', { style: {
          display: 'flex', alignItems: 'center', backgroundColor: '#b94427', color: '#fff8e8',
          fontSize: 30, padding: '16px 30px', borderRadius: 999,
        } }, price ? `Join live · ${price}` : 'Join live'),
        h('div', { style: { display: 'flex', marginLeft: 22, fontSize: 21, color: '#ab3421' } }, 'saathum.com'),
      ),
    ),
    h('div', { style: { display: 'flex', flex: 1, backgroundColor: '#f4dbad', borderRadius: '240px 240px 18px 18px', overflow: 'hidden', border: '5px solid #d39f53' } },
      h('img', { src: artwork, width: 506, height: 526, style: { width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center' } }),
    ),
  );
}

export function ogTemplate(record: OgRecord, artwork: string) {
  if (record.ad?.hook) return adTemplate(record, artwork, record.ad);
  const title = copy(record.title, 105) || 'Sacred rituals, shared live';
  const description = copy(record.description, 150);
  return h('div', { style: {
    width: 1200, height: 630, display: 'flex', position: 'relative', overflow: 'hidden',
    backgroundColor: '#fff8e8', color: '#304d35', fontFamily: 'Comfortaa', fontWeight: 700,
    padding: 44, border: '12px solid #b94427',
  } },
    h('div', { style: { display: 'flex', flexDirection: 'column', width: 620, paddingRight: 36 } },
      h('div', { style: { display: 'flex', fontSize: 46, color: '#ab3421', marginBottom: 26 } }, 'Saa Thum'),
      h('div', { style: { display: 'flex', fontSize: 17, letterSpacing: 2, color: '#9b4b24', marginBottom: 22 } }, labels[record.kind]),
      h('div', { style: { display: 'flex', fontSize: title.length > 74 ? 40 : 49, lineHeight: 1.18, letterSpacing: -1, overflow: 'hidden', maxHeight: 245 } }, title),
      description ? h('div', { style: { display: 'flex', fontSize: 21, lineHeight: 1.4, marginTop: 20, maxHeight: 92, overflow: 'hidden', color: '#5a614d' } }, description) : null,
      h('div', { style: { display: 'flex', marginTop: 'auto', paddingTop: 20, fontSize: 19, color: '#ab3421' } }, 'saathum.com'),
    ),
    h('div', { style: { display: 'flex', flex: 1, marginTop: 10, marginBottom: 10, backgroundColor: '#f4dbad', borderRadius: '180px 180px 14px 14px', overflow: 'hidden', border: '4px solid #d39f53' } },
      h('img', { src: artwork, width: 444, height: 498, style: { width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center' } }),
    ),
  );
}
