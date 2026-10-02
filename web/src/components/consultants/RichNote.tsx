// [AUMFE-CONSULT-F1-1 2026-10-02] Renders a content string that may contain <strong>…</strong> without ever using
// innerHTML — consultant names are substituted into these strings, so they must stay plain text.
import { fill } from './categoryContent';

export default function RichNote({ text, name }: { text: string; name: string }) {
  const parts = text.split(/(<strong>.*?<\/strong>)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^<strong>(.*)<\/strong>$/);
        return m ? <strong key={i}>{fill(m[1], name)}</strong> : <span key={i}>{fill(p, name)}</span>;
      })}
    </>
  );
}
