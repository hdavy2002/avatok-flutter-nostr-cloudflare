import { createElement as h } from 'react';
import type { OgRecord } from './types';

const labels: Record<OgRecord['kind'], string> = {
  home: 'SACRED RITUALS, SHARED LIVE', page: 'SAATHUM', collection: 'EXPLORE SAATHUM',
  article: 'RITUAL STORIES & GUIDES', help: 'HERE TO HELP', listing: 'LIVE RITUALS',
  creator: 'MEET THE ORGANISER', agent: 'EXPLORE SAATHUM',
};

/** Titles are text nodes, never HTML. Hard limits keep pathological records inside the card. */
function copy(value: string | undefined, limit: number): string {
  const text = (value ?? '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit - 3).join('').trimEnd() + '...';
}

export function ogTemplate(record: OgRecord, artwork: string) {
  const title = copy(record.title, 105) || 'Sacred rituals, shared live';
  const description = copy(record.description, 150);
  return h('div', { style: {
    width: 1200, height: 630, display: 'flex', position: 'relative', overflow: 'hidden',
    backgroundColor: '#fff8e8', color: '#304d35', fontFamily: 'Comfortaa', fontWeight: 700,
    padding: 44, border: '12px solid #b94427',
  } },
    h('div', { style: { display: 'flex', flexDirection: 'column', width: 620, paddingRight: 36 } },
      h('div', { style: { display: 'flex', fontSize: 46, color: '#ab3421', marginBottom: 26 } }, 'Saathum'),
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
