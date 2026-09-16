import { indiaChromeDictionaries } from './indiaLandingChrome';
import { defaultLocale, getIndiaLandingLocale } from './indiaLandingLocales';
import { indiaPageDictionaries } from './indiaLandingDictionaries';
export const INDIA_LANDING_LANGUAGE_KEY = 'avatok.india.landing.language';
export const INDIA_LANGUAGE_CHANGE = 'india:languagechange';
const fonts:Record<string,string> = { hi:'Noto Sans Devanagari',mr:'Noto Sans Devanagari',doi:'Noto Sans Devanagari',brx:'Noto Sans Devanagari',kok:'Noto Sans Devanagari',mai:'Noto Sans Devanagari',ne:'Noto Sans Devanagari',sa:'Noto Sans Devanagari',as:'Noto Sans Bengali',bn:'Noto Sans Bengali',gu:'Noto Sans Gujarati',kn:'Noto Sans Kannada',ml:'Noto Sans Malayalam',or:'Noto Sans Oriya',pa:'Noto Sans Gurmukhi',ta:'Noto Sans Tamil',te:'Noto Sans Telugu',mni:'Noto Sans Meetei Mayek',sat:'Noto Sans Ol Chiki',ks:'Noto Naskh Arabic',sd:'Noto Naskh Arabic',ur:'Noto Naskh Arabic'};
let initialized = false;
export function initIndiaLandingLanguage(root: ParentNode = document) {
  const controls = [...root.querySelectorAll<HTMLSelectElement>('[data-india-language-select]')];
  if (!controls.length || !root.querySelector('[data-india-page]') || initialized) return;
  initialized = true;
  const apply = (requested: string) => {
    const locale = getIndiaLandingLocale(requested);
    if (!indiaPageDictionaries[locale.code]) return;
    const values = { ...locale.translations, ...indiaChromeDictionaries[locale.code], ...indiaPageDictionaries[locale.code] };
    root.querySelectorAll<HTMLElement>('[data-india-i18n]').forEach(node => {
      const key=node.dataset.indiaI18n!;
      if (Object.hasOwn(values,key)) node.textContent=values[key];
    });
    root.querySelectorAll<HTMLElement>('[data-india-i18n-attr]').forEach(node => {
      for(const spec of (node.dataset.indiaI18nAttr || '').split('|')) {
        const [attr,key]=spec.split(':');
        if(['aria-label','title','placeholder','alt'].includes(attr) && Object.hasOwn(values,key)) node.setAttribute(attr,values[key]);
      }
    });
    document.documentElement.lang=locale.code;
    document.documentElement.dir=locale.dir;
    document.documentElement.dataset.indiaLocale=locale.code;
    const family=fonts[locale.code];
    document.documentElement.style.setProperty('--india-script-font',family ? '"' + family + '", sans-serif' : 'inherit');
    if(family && !document.querySelector('link[data-india-font="'+locale.code+'"]')) {
      const link=document.createElement('link'); link.rel='stylesheet'; link.dataset.indiaFont=locale.code;
      link.href='https://fonts.googleapis.com/css2?family='+encodeURIComponent(family)+':wght@400;500;600;700&display=swap';
      document.head.append(link);
    }
    // Keep the canonical page metadata authored by its Astro route.
    controls.forEach(select=>{select.value=locale.code;});
    try { window.localStorage.setItem(INDIA_LANDING_LANGUAGE_KEY,locale.code); } catch {}
    window.dispatchEvent(new CustomEvent(INDIA_LANGUAGE_CHANGE,{detail:{code:locale.code,dir:locale.dir}}));
  };
  controls.forEach(select=>select.addEventListener('change',()=>apply(select.value)));
  let saved:string=defaultLocale;
  try { saved=window.localStorage.getItem(INDIA_LANDING_LANGUAGE_KEY)||defaultLocale; } catch {}
  apply(indiaPageDictionaries[saved] ? saved : defaultLocale);
}
