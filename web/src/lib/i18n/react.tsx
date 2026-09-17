import { useEffect, useSyncExternalStore } from 'react';
import { translateKnownSource, getRevision, getLocale, subscribe, t, registerNamespace, refreshLocale, locales, setUiLocale } from './localeStore';
export function useTranslation(namespace='common') {
  const revision=useSyncExternalStore(subscribe,getRevision,()=>0);
  // SSR and the first hydration pass use authored source even if another island restored a locale.
  const hydrated=revision!==0;
  const locale=hydrated?getLocale():'en';
  const sourceT=(_key:string,fallback:string,params:Record<string,string|number>={})=>fallback.replace(/\{([a-zA-Z0-9_]+)\}/g,(token,name)=>Object.hasOwn(params,name)?String(params[name]):token);
  useEffect(()=>{const unregister=registerNamespace(namespace);refreshLocale();return unregister;},[namespace]);
  return {t:hydrated?t:sourceT,locale,source:hydrated?translateKnownSource:(value:string)=>value,number:(value:number,options?:Intl.NumberFormatOptions)=>new Intl.NumberFormat(locale,options).format(value)};
}
export function LanguageSelector() {const {locale,t}=useTranslation();return <select aria-label={t('chrome.chooseLanguage','Choose language')} value={locale} onChange={e=>void setUiLocale(e.target.value)}>{locales.map(item=><option key={item.code} value={item.code}>{item.nativeName}</option>)}</select>;}

export function UiText({id,source}:{id:string;source:string}) {const {t}=useTranslation(id.split('.')[0]);return <>{t(id,source)}</>;}

export function UiMessage({namespace,value}:{namespace:string;value:string|null|undefined}) {const {source}=useTranslation(namespace);return <>{value?source(value):value}</>;}
