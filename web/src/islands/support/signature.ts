// [HF-SUPPORT-DESK] Signature helpers: email-safe font stacks, fill-ins, the default block, and the converter that turns
// whatever the editor holds into email-safe HTML (inline styles only, table layout, safe fonts, no classes/scripts).
import { BRAND } from '../../lib/brand';
import { esc } from './format';
import { sanitizeHtml } from './sanitize';

export const FONT_STACKS: { label: string; stack: string }[] = [
  { label: 'Arial (email-safe)', stack: 'Arial, Helvetica, sans-serif' },
  { label: 'Georgia (email-safe)', stack: "Georgia, 'Times New Roman', serif" },
  { label: 'Verdana (email-safe)', stack: 'Verdana, Geneva, sans-serif' },
  { label: 'Trebuchet (email-safe)', stack: "'Trebuchet MS', Helvetica, sans-serif" },
  { label: 'Tahoma (email-safe)', stack: 'Tahoma, Geneva, sans-serif' },
  { label: 'Nunito (falls back to Arial)', stack: 'Nunito, Arial, Helvetica, sans-serif' },
];
export const FONT_SIZES = [12, 14, 16, 18];
export const BASE_FONT = FONT_STACKS[0].stack;

/** Tokens the server replaces when it sends. The editor shows them as plain text. */
export const FILL_INS: { token: string; label: string; sample: (ctx: SampleCtx) => string }[] = [
  { token: '{agent_name}', label: 'Agent name', sample: (c) => c.agentName },
  { token: '{support_email}', label: 'Support email', sample: () => BRAND.emails.support },
  { token: '{website}', label: 'Website', sample: () => BRAND.domain },
  { token: '{ticket_number}', label: 'Ticket number', sample: () => 'HF-10240' },
];
export interface SampleCtx { agentName: string }

/** Replace fill-ins with sample text. Tolerates the spaced spelling used in the design ("{agent name}"). */
export function fillSample(html: string, ctx: SampleCtx): string {
  let out = html;
  for (const f of FILL_INS) {
    const spaced = f.token.replace(/_/g, ' ');
    out = out.split(f.token).join(esc(f.sample(ctx))).split(spaced).join(esc(f.sample(ctx)));
  }
  return out;
}

const INK = '#2B1530';
const PLUM = '#4A1747';
const MUTED = '#6F5B6F';
const LINK = '#6D4FD0';

/** The starting signature: logo cell + text cell in a table, then an optional divider. */
export function defaultSignature(logoUrl?: string | null): string {
  const logo = logoUrl
    ? `<td valign="middle" style="padding:0 14px 0 0"><img src="${esc(logoUrl)}" width="64" height="64" alt="${esc(BRAND.name)}" style="display:block;border:0;width:64px;height:64px"></td>`
    : '';
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:${BASE_FONT};font-size:14px;line-height:1.5;color:${INK}"><tr>` +
    logo +
    `<td valign="middle" style="font-family:${BASE_FONT};font-size:14px;line-height:1.5;color:${INK}">` +
    `<div style="font-weight:bold;font-size:16px;color:${PLUM}">{agent_name}</div>` +
    `<div>${esc(BRAND.name)} Support</div>` +
    `<div><a href="mailto:{support_email}" style="color:${LINK};text-decoration:underline">{support_email}</a> · <a href="https://{website}" style="color:${LINK};text-decoration:underline">{website}</a></div>` +
    `<div style="color:${MUTED};font-size:12px">Ticket {ticket_number} · Mon–Sat, 10 am–7 pm IST</div>` +
    `</td></tr></table>`
  );
}

export function dividerHtml(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:12px 0"><tr><td style="border-top:1px solid #E4D6C2;font-size:1px;line-height:1px;height:1px">&nbsp;</td></tr></table>`;
}

export interface SocialLink { key: 'instagram' | 'youtube' | 'facebook' | 'x' | 'whatsapp'; label: string; short: string; colour: string; url: string }
export const SOCIALS: Omit<SocialLink, 'url'>[] = [
  { key: 'instagram', label: 'Instagram', short: 'IG', colour: '#D81B72' },
  { key: 'youtube', label: 'YouTube', short: 'YT', colour: '#C0262D' },
  { key: 'facebook', label: 'Facebook', short: 'f', colour: '#6D4FD0' },
  { key: 'x', label: 'X', short: 'X', colour: '#2B1530' },
  { key: 'whatsapp', label: 'WhatsApp', short: 'WA', colour: '#0E7C86' },
];

/** Coloured round links (no image hosting needed, so they never get blocked as remote images). */
export function socialHtml(links: { key: SocialLink['key']; url: string }[]): string {
  const cells = links
    .filter((l) => /^https?:\/\//i.test(l.url))
    .map((l) => {
      const s = SOCIALS.find((x) => x.key === l.key);
      if (!s) return '';
      return (
        `<td style="padding:0 8px 0 0"><a href="${esc(l.url)}" target="_blank" style="display:block;width:26px;height:26px;border-radius:13px;background:${s.colour};` +
        `color:#FFFFFF;font-family:${BASE_FONT};font-size:11px;font-weight:bold;line-height:26px;text-align:center;text-decoration:none">${esc(s.short)}</a></td>`
      );
    })
    .join('');
  if (!cells) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:8px 0 0 0"><tr>${cells}</tr></table>`;
}

/** A logo + text block around an uploaded logo image (public URL from the attachments endpoint). */
export function logoImgHtml(url: string): string {
  return `<img src="${esc(url)}" width="64" height="64" alt="${esc(BRAND.name)}" style="display:block;border:0;width:64px;height:64px">`;
}

/**
 * Whatever the editor holds -> email-safe HTML.
 *  - sanitised with the allow-list (no scripts, handlers, classes, odd URLs)
 *  - <b>/<i>/<font> become <strong>/<em>/<span style>
 *  - the whole thing sits in one wrapper that carries a safe base font, so clients that drop <body> styles still render it
 *  - images get display:block;border:0 and explicit width/height
 */
export function toEmailSafe(editorHtml: string): string {
  const clean = sanitizeHtml(editorHtml);
  if (!clean.trim() || typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html');
  doc.querySelectorAll('b').forEach((b) => rename(doc, b, 'strong'));
  doc.querySelectorAll('i').forEach((b) => rename(doc, b, 'em'));
  doc.querySelectorAll('img').forEach((img) => {
    const st = (img.getAttribute('style') ?? '').replace(/;?$/, ';');
    img.setAttribute('style', `${st}display:block;border:0;`.replace(/^;/, ''));
    if (!img.getAttribute('width')) img.setAttribute('width', '64');
  });
  doc.querySelectorAll('table').forEach((t) => {
    t.setAttribute('role', 'presentation');
    if (!t.hasAttribute('cellpadding')) t.setAttribute('cellpadding', '0');
    if (!t.hasAttribute('cellspacing')) t.setAttribute('cellspacing', '0');
    if (!t.hasAttribute('border')) t.setAttribute('border', '0');
  });
  doc.querySelectorAll('a').forEach((a) => {
    if (!a.getAttribute('style')) a.setAttribute('style', `color:${LINK};text-decoration:underline`);
  });
  return `<div style="font-family:${BASE_FONT};font-size:14px;line-height:1.5;color:${INK}">${doc.body.innerHTML}</div>`;
}

function rename(doc: Document, el: Element, tag: string): void {
  const n = doc.createElement(tag);
  for (const a of Array.from(el.attributes)) n.setAttribute(a.name, a.value);
  while (el.firstChild) n.appendChild(el.firstChild);
  el.replaceWith(n);
}
