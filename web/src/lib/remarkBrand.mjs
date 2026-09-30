// [SAATHUM-BRAND-CENTRAL-WEB-3] Remark plugin: fills {{brand.*}} tokens in repository
// markdown (help articles). Must run BEFORE remarkUiCopy so the i18n content keys are
// hashed from the final text. Code and inline code are left untouched.
import { fillBrandTokens } from './brandTokens.ts';

export default function remarkBrand() {
  return (tree) => {
    const walk = (node) => {
      if (node.type === 'code' || node.type === 'inlineCode') return;
      // Astro's smartypants runs BEFORE this plugin, so a quote right after "}}" was curled as an
      // OPENING quote. Once the token becomes a word it must be the closing/apostrophe form.
      if (node.type === 'text' && typeof node.value === 'string') {
        node.value = node.value.replace(/(\{\{brand\.\w+\}\})([\u2018\u201C])/g, (_m, t, q) => t + (q === '\u2018' ? '\u2019' : '\u201D'));
      }
      for (const key of ['value', 'url', 'title', 'alt']) {
        if (typeof node[key] === 'string' && node[key].includes('{{brand.')) {
          if (key === 'value' && !['text', 'html'].includes(node.type)) continue;
          node[key] = fillBrandTokens(node[key]);
        }
      }
      if (node.children) node.children.forEach(walk);
    };
    walk(tree);
  };
}
