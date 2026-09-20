import { manifest, getCatalog, getCompatibleCachedCatalog } from './catalogClient';
import registry from '../../../../shared/i18n/locales.json';
export const locales = registry;
export type UiLocale = typeof locales[number];
type Seed={reviewed:boolean;messages:Record<string,{source:string;text:string}>};
const sourceImports=import.meta.glob<{default:Record<string,string>}>('../../../../shared/i18n/source/*.json');
const seedImports=import.meta.glob<{default:Seed}>('../../../../shared/i18n/reviewed/*/*.json');
let pendingLocale:string|null=null,restored=false;
let revision=0,locale='en',account:string|null=null,epoch=0,status='source';
let messages:Record<string,string>={},sources:Record<string,string>={};
const sourceHashPromises=new Map<string,Promise<string>>();
async function sourceHash(namespace:string,copy:Record<string,string>){let promise=sourceHashPromises.get(namespace);if(!promise){const canonical=JSON.stringify(Object.fromEntries(Object.keys(copy).sort().map(key=>[key,copy[key]])));promise=crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical)).then(bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join(''));sourceHashPromises.set(namespace,promise);}return promise;}
const lastGood=new Map<string,{release:string;messages:Record<string,string>}>();
const listeners=new Set<()=>void>(),domNamespaces=new Set<string>(['common']);
const islandNamespaces=new Map<string,number>();
export const subscribe=(fn:()=>void)=>{listeners.add(fn);return ()=>{listeners.delete(fn);};};
export const getRevision=()=>revision;
export const getLocale=()=>locale;
export const getLocaleStatus=()=>status;
export const serverLocale=()=> 'en';
const key=()=> 'avatok.ui.locale.'+(account?'account.'+encodeURIComponent(account):'guest');
export function registerNamespace(namespace:string) {islandNamespaces.set(namespace,(islandNamespaces.get(namespace)||0)+1);return ()=>{const n=(islandNamespaces.get(namespace)||1)-1;if(n)islandNamespaces.set(namespace,n);else islandNamespaces.delete(namespace);};}
export function setDomNamespaces(values:string[]) {domNamespaces.clear();domNamespaces.add('common');values.forEach(ns=>domNamespaces.add(ns));}
// The caller's `fallback` is the live markup (the `source` prop baked into the current build);
// `sources[key]` is the shared/i18n/source/<ns>.json catalog, which can lag behind it (e.g. a
// stream renaming an English string under an existing key without regenerating the catalog).
// A real translation in `messages[key]` (non-`en` locale) still wins first; otherwise the live
// fallback must beat the possibly-stale catalog, so callers never see reverted copy after hydration.
export function t(key:string,fallback:string,params:Record<string,string|number>={}) {return (messages[key]??(fallback||(sources[key]??''))).replace(/\{([a-zA-Z0-9_]+)\}/g,(token,name)=>Object.hasOwn(params,name)?String(params[name]):token);}
function notify(){revision++;listeners.forEach(fn=>fn());}
export async function setUiLocale(requested:string,persist=true) {
 const chosen=locales.find(value=>value.code===requested)||locales.find(value=>value.code==='en')!;
 pendingLocale=chosen.code;
 if(persist)try {localStorage.setItem(key(),chosen.code);}catch {}
 const token=++epoch,start=performance.now(),active=[...new Set([...domNamespaces,...islandNamespaces.keys()])];
 const hashes:Record<string,string>={};const compatibleFallbackReleases=new Set<string>();
 const resolved=new Set<string>(),draftKeys=new Set<string>();
 let next:Record<string,string>={},source:Record<string,string>={},draft=false,release='bundled',publishedCount=0;
 await Promise.all(active.map(async ns=>{const loader=sourceImports['../../../../shared/i18n/source/'+ns+'.json'];if(loader){const copy=(await loader()).default;Object.assign(source,copy);try{if(chosen.code!=='en')hashes[ns]=await sourceHash(ns,copy);}catch{/* Unsupported WebCrypto fails closed to source text. */}}}));
 if(chosen.code!=='en')await Promise.all(active.map(async ns=>{const loader=seedImports['../../../../shared/i18n/reviewed/'+chosen.code+'/'+ns+'.json'];if(!loader)return;const seed=(await loader()).default;
  for(const [key,item]of Object.entries(seed.messages))if(source[key]===item.source){next[key]=item.text;if(!seed.reviewed)draftKeys.add(key);}}));
 const applyCatalog=(ns:string,catalog:{release:string;messages:Record<string,string>})=>{
  Object.assign(next,catalog.messages);Object.keys(catalog.messages).forEach(key=>draftKeys.delete(key));
  resolved.add(ns);publishedCount++;
  lastGood.set(chosen.code+'/'+ns+'/'+hashes[ns],catalog);
  if(lastGood.size>64)lastGood.delete(lastGood.keys().next().value!);
 };
 if(chosen.code!=='en')try {
  const published=await manifest();release=published.release;
  const allowed=published.locales[chosen.code]?.namespaces||[];
  await Promise.all(active.filter(ns=>allowed.includes(ns)&&hashes[ns]&&published.sourceHashes[ns]===hashes[ns]).map(async ns=>{
   try {const catalog=await getCatalog(release,chosen.code,ns);if(catalog.sourceHash===hashes[ns])applyCatalog(ns,catalog);}catch {}
  }));
 }catch {/* Compatible immutable caches remain usable without a manifest. */}
 if(chosen.code!=='en')await Promise.all(active.filter(ns=>hashes[ns]&&!resolved.has(ns)).map(async ns=>{
  let compatible=lastGood.get(chosen.code+'/'+ns+'/'+hashes[ns]);
  if(!compatible){const stored=await getCompatibleCachedCatalog(chosen.code,ns,hashes[ns]);if(stored)compatible=stored;}
  if(compatible){applyCatalog(ns,compatible);compatibleFallbackReleases.add(compatible.release);}
 }));
 draft=draftKeys.size>0;
 if(token!==epoch)return;
 pendingLocale=null;restored=true;sources=source;messages=next;locale=chosen.code;
 const missing=Object.keys(source).filter(key=>!(key in next)).length;
 status=locale==='en'?'source':draft?'draft':missing>0?'partial':publishedCount?'available':'unavailable';
 const fonts:Record<string,string>={bho:'Noto Sans Devanagari',awa:'Noto Sans Devanagari',hi:'Noto Sans Devanagari',mr:'Noto Sans Devanagari',doi:'Noto Sans Devanagari',brx:'Noto Sans Devanagari',kok:'Noto Sans Devanagari',mai:'Noto Sans Devanagari',ne:'Noto Sans Devanagari',sa:'Noto Sans Devanagari',as:'Noto Sans Bengali',bn:'Noto Sans Bengali',gu:'Noto Sans Gujarati',kn:'Noto Sans Kannada',ml:'Noto Sans Malayalam',or:'Noto Sans Oriya',pa:'Noto Sans Gurmukhi',ta:'Noto Sans Tamil',te:'Noto Sans Telugu',mni:'Noto Sans Meetei Mayek',sat:'Noto Sans Ol Chiki',ks:'Noto Naskh Arabic',sd:'Noto Naskh Arabic',ur:'Noto Naskh Arabic'};
 const font=fonts[locale];document.documentElement.style.setProperty('--india-script-font',font?'"'+font+'", sans-serif':'inherit');
 if(font&&!document.querySelector('link[data-ui-font="'+locale+'"]')){const link=document.createElement('link');link.rel='stylesheet';link.dataset.uiFont=locale;link.href='https://fonts.googleapis.com/css2?family='+encodeURIComponent(font)+':wght@400;500;600;700&display=swap';document.head.append(link);}
 document.documentElement.lang=locale;document.documentElement.dir=chosen.dir;document.documentElement.dataset.indiaLocale=locale;
 notify();
 window.dispatchEvent(new CustomEvent('india:languagechange',{detail:{code:locale,dir:chosen.dir}}));
 import('../analytics').then(({capture})=>capture('ui_locale_change',{locale,release,duration_ms:performance.now()-start,catalog_status:status,missing_keys:missing,loaded_keys:Object.keys(messages).length,compatible_fallback_releases:[...compatibleFallbackReleases]})).catch(()=>undefined);
}
export function restoreLocale() {let saved='en';try {saved=localStorage.getItem(key())||'en';}catch {}return setUiLocale(saved,false);}
let refreshQueued=false;
export function refreshLocale(){if(refreshQueued)return;refreshQueued=true;queueMicrotask(()=>{refreshQueued=false;if(!restored&&!pendingLocale)void restoreLocale();else void setUiLocale(pendingLocale||locale,false);});}
export function setLocaleAccount(id:string|null) {if(id===account)return;const wasGuest=account===null;account=id;if(wasGuest&&id)try{if(localStorage.getItem(key())===null){const guest=localStorage.getItem('avatok.ui.locale.guest');if(guest&&locales.some(item=>item.code===guest))localStorage.setItem(key(),guest);}}catch {}epoch++;pendingLocale=null;restored=false;messages={};sources={};locale='en';status='source';notify();void restoreLocale();}

export function translateKnownSource(value:string) {const key=Object.keys(sources).find(key=>sources[key]===value&&key in messages);return key?t(key,value):value;}
