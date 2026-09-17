import { API_BASE } from '../config';
export type Catalog = { schemaVersion: 1; release: string; locale: string; namespace: string; messages: Record<string,string>; sourceHash: string };
export type Manifest = {schemaVersion:1; release:string; locales:Record<string,{namespaces:string[];status:string}>; namespaces:string[];sourceHashes:Record<string,string>};
const origin = API_BASE.replace(/\/$/, '');
const cacheName = 'avatok-public-ui-v1';
let lastManifest:Manifest|undefined;
let manifestPromise: Promise<Manifest> | undefined, manifestAt=0;
const catalogs=new Map<string,Promise<Catalog>>();
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
async function boundedJson(response:Response):Promise<unknown>{
 const reader=response.body?.getReader();if(!reader)throw Error('Empty catalog');const chunks:Uint8Array[]=[];let size=0;
 try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();throw Error('Catalog exceeds size limit');}chunks.push(value);}}finally {reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder().decode(bytes));
}
const segment=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z0-9._-]{1,128}$/.test(value);
function validManifest(value:unknown):value is Manifest {
  if(!value||typeof value!=='object')return false;
  const v=value as Manifest;
  return v.schemaVersion===1 && hash(v.release) && Array.isArray(v.namespaces) && v.namespaces.every(segment) && !!v.sourceHashes && typeof v.sourceHashes==='object' && !Array.isArray(v.sourceHashes) && v.namespaces.every(ns=>hash(v.sourceHashes[ns])) && !!v.locales && typeof v.locales==='object' && !Array.isArray(v.locales) && Object.entries(v.locales).every(([code,item])=>segment(code)&&item&&Array.isArray(item.namespaces)&&item.namespaces.every(ns=>v.namespaces.includes(ns))&&['source','reviewed','machine'].includes(item.status));
}
export function manifest(): Promise<Manifest> {
  if(!lastManifest)try {const raw=localStorage.getItem('avatok.ui.manifest.'+origin)||'null';if(raw.length<=2*1024*1024){const saved:unknown=JSON.parse(raw);if(validManifest(saved))lastManifest=saved;}}catch {}
  const cached=lastManifest;
  if(!manifestPromise||Date.now()-manifestAt>=60000){
    manifestAt=Date.now();
    manifestPromise=fetch(origin+'/i18n/v1/manifest.json',{credentials:'omit',cache:'no-cache',signal:AbortSignal.timeout(5000)})
      .then(async response=>{if(!response.ok)throw Error('Catalog manifest unavailable');const value=await boundedJson(response);if(!validManifest(value))throw Error('Invalid catalog manifest');
        const previous=lastManifest;lastManifest=value;try {localStorage.setItem('avatok.ui.manifest.'+origin,JSON.stringify(value));}catch {}
        if(previous&&previous.release!==value.release)window.dispatchEvent(new CustomEvent('avatok:catalog-release'));
        return value;
      }).catch(error=>{if(lastManifest)return lastManifest;throw error;});
    // Cached copy is returned immediately; revalidation failure stays in the background.
    if(cached)void manifestPromise.catch(()=>undefined);
  }
  return cached?Promise.resolve(cached):manifestPromise!;
}
export function getCatalog(release:string, locale:string, namespace:string):Promise<Catalog> {
  const key=[release,locale,namespace].join('/');const existing=catalogs.get(key);if(existing)return existing;
  const load=loadCatalog(release,locale,namespace).catch(error=>{catalogs.delete(key);throw error;});catalogs.set(key,load);
  if(catalogs.size>64)catalogs.delete(catalogs.keys().next().value!);return load;
}
async function loadCatalog(release:string,locale:string,namespace:string):Promise<Catalog> {
  if(!hash(release)||![locale,namespace].every(segment))throw Error('Invalid catalog path');
  const url=origin+'/i18n/v1/'+[release,locale,namespace+'.json'].map(encodeURIComponent).join('/');
  let cache:Cache|undefined;try {cache=await caches.open(cacheName);}catch {}
  const cached=await cache?.match(url).catch(()=>undefined);
  async function decode(response:Response):Promise<Catalog>{
    if(!response.ok)throw Error('Catalog unavailable');const value=await boundedJson(response.clone()) as Catalog;
    if(value.schemaVersion!==1||value.release!==release||value.locale!==locale||value.namespace!==namespace||!hash(value.sourceHash)||!value.messages||typeof value.messages!=='object'||Array.isArray(value.messages)||Object.values(value.messages).some(v=>typeof v!=='string'))throw Error('Invalid catalog');return value;
  }
  if(cached)try {return await decode(cached);}catch {await cache?.delete(url).catch(()=>undefined);}
  const response=await fetch(url,{credentials:'omit',cache:'force-cache',signal:AbortSignal.timeout(5000)});
  const value=await decode(response);
  if(cache)try {await cache.put(url,response);const keys=await cache.keys();await Promise.all(keys.slice(0,Math.max(0,keys.length-64)).map(key=>cache!.delete(key)));}catch {}
  return value;
}

/** A compatible immutable release is safe only when its canonical source hash matches. */
export async function getCompatibleCachedCatalog(locale:string,namespace:string,sourceHash:string):Promise<Catalog|null>{
 if(![locale,namespace].every(segment)||!hash(sourceHash))return null;
 let cache:Cache;try{cache=await caches.open(cacheName);}catch{return null;}
 const prefix=origin+'/i18n/v1/';const keys=(await cache.keys().catch(()=>[])).slice(-64).reverse();
 for(const request of keys){
  if(!request.url.startsWith(prefix))continue;
  const parts=request.url.slice(prefix.length).split('/');
  if(parts.length!==3||!hash(parts[0])||parts[1]!==encodeURIComponent(locale)||parts[2]!==encodeURIComponent(namespace+'.json'))continue;
  try {const response=await cache.match(request);if(!response?.ok)throw Error('Invalid cached response');const value=await boundedJson(response) as Catalog;
   if(!value||value.schemaVersion!==1||value.release!==parts[0]||value.locale!==locale||value.namespace!==namespace||!hash(value.sourceHash)||!value.messages||typeof value.messages!=='object'||Array.isArray(value.messages)||Object.values(value.messages).some(message=>typeof message!=='string'))throw Error('Invalid cached catalog');
   if(value.sourceHash===sourceHash)return value;
  }catch {await cache.delete(request).catch(()=>undefined);}
 }
 return null;
}
