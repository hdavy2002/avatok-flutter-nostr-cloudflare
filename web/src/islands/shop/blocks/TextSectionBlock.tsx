// [SAATHUM-SHOP-EDITOR-1 2026-10-01] A heading (with the ✽ mark) and a paragraph — an extra block for the editor.
import type { BlockCtx, TextSectionProps } from './types';
import { has, t, spaced } from './util';

export default function TextSectionBlock(p: TextSectionProps & { ctx?: BlockCtx }) {
  return (
    <section className="sh-sec">
      <div className="sh-sec-head sh-text"><div><h2><span>✽</span>{spaced(p.heading)}</h2>{has(p.text) && <p>{t(p.text)}</p>}</div></div>
    </section>
  );
}
