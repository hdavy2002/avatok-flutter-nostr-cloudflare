// [SAATHUM-PREETI-1] Plain-text renderer: line breaks, **bold**, auto-linked
// http(s) URLs. Builds React nodes only - no HTML string is ever injected.
import { Fragment } from 'react';
import type { ReactNode } from 'react';

const URL_RE = /(https?:\/\/[^\s<]+)/g;
const BOLD_RE = /(\*\*[^*\n]+\*\*)/g;

export function safeHref(url: string): string | null {
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function linkify(text: string, keyBase: string): ReactNode[] {
  return text.split(URL_RE).map((part, i) => {
    if (i % 2 === 0) return part;
    const m = /[.,;:!?)\]]+$/.exec(part);
    const trail = m ? m[0] : '';
    const url = trail ? part.slice(0, -trail.length) : part;
    const href = safeHref(url);
    if (!href) return part;
    return (
      <Fragment key={`${keyBase}-${i}`}>
        <a href={href} target="_blank" rel="noopener noreferrer">{url}</a>
        {trail}
      </Fragment>
    );
  });
}

function inline(line: string, keyBase: string): ReactNode[] {
  return line.split(BOLD_RE).map((part, i) => {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${keyBase}-b${i}`}>{linkify(part.slice(2, -2), `${keyBase}-b${i}`)}</strong>;
    }
    return <Fragment key={`${keyBase}-t${i}`}>{linkify(part, `${keyBase}-t${i}`)}</Fragment>;
  });
}

export function RichText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {inline(line, String(i))}
        </Fragment>
      ))}
    </>
  );
}
