import { setDomNamespaces, getLocaleStatus, refreshLocale, setUiLocale, subscribe, t, getLocale } from './localeStore';
const originals=new WeakMap<Element,Record<string,string>>();
function apply(root:ParentNode) {
  root.querySelectorAll<HTMLElement>('[data-india-i18n],[data-i18n]').forEach(node=>{
    if(node.closest('astro-island') || node.childElementCount) return;
    const source=originals.get(node)||{text:node.textContent||''}; originals.set(node,source);
    node.textContent=t(node.dataset.i18n||node.dataset.indiaI18n!,source.text);
  });
  root.querySelectorAll<HTMLElement>('[data-india-i18n-attr]').forEach(node=>{
    if(node.closest('astro-island'))return;
    const source=originals.get(node)||{}; originals.set(node,source);
    for(const spec of (node.dataset.indiaI18nAttr||'').split('|')) {const [attr,key]=spec.split(':'); if(!['aria-label','title','placeholder','alt'].includes(attr))continue;
      source[attr]??=node.getAttribute(attr)||'';node.setAttribute(attr,t(key,source[attr]));}
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-meta]').forEach(node=>{const source=originals.get(node)||{text:node.tagName==='META'?node.getAttribute('content')||'':node.textContent||''};originals.set(node,source);const text=t(node.dataset.i18nMeta!,source.text);if(node.tagName==='META')node.setAttribute('content',text);else node.textContent=text;});
  root.querySelectorAll<HTMLElement>('[data-ui-locale-status]').forEach(node=>{const status=getLocaleStatus();node.textContent=status==='source'||status==='available'?'':status==='draft'?t('chrome.translationDraft','Draft translation · some text uses source language'):t('chrome.translationIncomplete','Translation incomplete · some text uses source language');});
  root.querySelectorAll<HTMLSelectElement>('[data-india-language-select]').forEach(select=>{select.value=getLocale();});
}
let installed=false;
export function initUiLocale(root:ParentNode=document) {
  const active=new Set<string>();
  root.querySelectorAll<HTMLElement>('[data-i18n-namespace]').forEach(node=>active.add(node.dataset.i18nNamespace!));
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach(node=>active.add(node.dataset.i18n!.split('.')[0]));
  if([...root.querySelectorAll<HTMLElement>('[data-india-i18n]')].some(node=>!node.dataset.indiaI18n?.startsWith('chrome.')))active.add('landing');
  root.querySelectorAll<HTMLElement>('[data-india-i18n-attr]').forEach(node=>{for(const spec of (node.dataset.indiaI18nAttr||'').split('|')){const key=spec.split(':')[1];if(key?.startsWith('web-'))active.add(key.split('.')[0]);}});
  root.querySelectorAll<HTMLElement>('[data-i18n-meta]').forEach(node=>active.add(node.dataset.i18nMeta!.split('.')[0]));
  setDomNamespaces([...active]);
  if(!installed) {installed=true;subscribe(()=>apply(document));document.addEventListener('change',event=>{const select=event.target;if(select instanceof HTMLSelectElement && select.matches('[data-india-language-select]'))void setUiLocale(select.value);});document.addEventListener('astro:page-load',()=>initUiLocale());window.addEventListener('avatok:catalog-release',()=>refreshLocale());window.addEventListener('avatok:locale',event=>{const code=(event as CustomEvent<{locale?:string}>).detail?.locale;if(code)void setUiLocale(code,false);});}
  apply(root);const hostLocale=(window as Window & {__avatokUiLocale?:string}).__avatokUiLocale;if(hostLocale)void setUiLocale(hostLocale,false);else refreshLocale();
}
