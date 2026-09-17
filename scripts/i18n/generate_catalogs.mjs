#!/usr/bin/env node
/** Explicit offline/CI catalog authoring. Never imported by a public request handler. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const canonical = value => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))]))
  : Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : value);
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export const sourceHash = messages => hash(messages);
const protectedPattern = /https?:\/\/[^\s<>"']+|\{[\w.]+\}|<[^>]+>|\b(?:[Aa][Vv][Aa][Tt][Oo][Kk]|Ava[A-Z][A-Za-z0-9]*|Google|Cloudflare)\b/g;
const complexIcu = /\{\s*[\w.]+\s*,/;
export function protect(text) {
  if (/AVATOKTOKEN\d+END/.test(text)) throw new Error('Reserved translation token in source');
  if (complexIcu.test(text)) throw new Error('ICU formatted/plural/select messages require reviewed translation');
  const tokens = [];
  const masked = text.replace(protectedPattern, token => { tokens.push(token); return `AVATOKTOKEN${tokens.length - 1}END`; });
  return { masked, restore(translated) {
    const found = translated.match(/AVATOKTOKEN\d+END/g) || [];
    if (found.length !== tokens.length || tokens.some((_, i) => found.filter(t => t === `AVATOKTOKEN${i}END`).length !== 1)) throw new Error('Provider changed a protected token');
    return translated.replace(/AVATOKTOKEN(\d+)END/g, (_, i) => tokens[Number(i)]);
  } };
}
function signature(text) {
  const protectedTokens = (text.match(protectedPattern) || []).sort();
  // Preserve ICU format instructions, option names, braces and pound substitutions.
  const controls = text.match(/\{\s*[\w.]+\s*,\s*(?:plural|selectordinal|select|number|date|time)(?:\s*,\s*[^{}]*)?|(?:=\d+|zero|one|two|few|many|other)\s*\{|offset:\s*\d+|[{}#]/g) || [];
  return canonical({ protectedTokens, controls });
}
export function validateMessages(source, messages, complete = true) {
  if (!messages || typeof messages !== 'object' || Array.isArray(messages) || (complete && !Object.keys(messages).length)) throw new Error('Invalid message map');
  for (const [key, text] of Object.entries(messages)) {
    if (!Object.hasOwn(source, key) || ['__proto__', 'constructor', 'prototype'].includes(key) || !key.length || key.length > 200 || typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error(`Invalid message: ${key}`);
    if (signature(source[key]) !== signature(text)) throw new Error(`Changed placeholders/markup/brands: ${key}`);
  }
  if (complete && Object.keys(source).some(k => !Object.hasOwn(messages, k))) throw new Error('Incomplete catalog');
}
async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (err) { if (err.code === 'ENOENT' && fallback !== undefined) return fallback; throw err; }
}
async function atomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path + '.tmp', canonical(value) + '\n');
  await rename(path + '.tmp', path);
}
async function immutable(path, value) {
  const text = canonical(value) + '\n';
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, text, { flag: 'wx' }); }
  catch (err) { if (err.code !== 'EEXIST' || await readFile(path, 'utf8') !== text) throw err; }
}
export async function generate({ root, output, cacheDir, allowPaid = false, maxCharacters = 0, fetchImpl = fetch, env = process.env }) {
  const started = Date.now();
  const locales = await json(join(root, 'shared/i18n/locales.json'));
  const sourceDir = join(root, 'shared/i18n/source');
  const namespaces = (await readdir(sourceDir)).filter(n => /^[a-z][a-z0-9_-]{0,63}\.json$/.test(n)).map(n => n.slice(0, -5)).sort();
  if (!namespaces.length) throw new Error('No source namespaces');
  const sources = {};
  for (const ns of namespaces) { sources[ns] = await json(join(sourceDir, ns + '.json')); validateMessages(sources[ns], sources[ns]); }
  const stats = { providerCharactersAttempted: 0, providerRequests: 0, reusedMessages: 0, reviewedMessages: 0, missing: [] };
  try {
  let supported = new Set();
  const project = env.GOOGLE_TRANSLATION_PROJECT;
  const token = env.GOOGLE_TRANSLATION_ACCESS_TOKEN;
  const providerVersion = 'google-v3-nmt-auto-v2';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (allowPaid) {
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(project || '') || !token || !Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) throw new Error('Paid mode requires dedicated project, OAuth token and positive character budget');
    const response = await fetchImpl(`https://translation.googleapis.com/v3/projects/${project}/locations/global/supportedLanguages`, { headers, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Provider language capability check failed (${response.status})`);
    supported = new Set(((await response.json()).languages || []).filter(l => l.supportTarget).map(l => l.languageCode));
  }
  const translateBatch = async (batch, target) => {
    const protectedItems = batch.map(item => protect(item.source));
    const contents = protectedItems.map(item => item.masked);
    const characters = contents.reduce((sum, text) => sum + Array.from(text).length, 0);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (stats.providerCharactersAttempted + characters > maxCharacters) throw new Error('Explicit provider character budget exhausted; cached progress retained');
      stats.providerCharactersAttempted += characters;
      stats.providerRequests++;
      let response;
      try { response = await fetchImpl(`https://translation.googleapis.com/v3/projects/${project}/locations/global:translateText`, {
        method: 'POST', headers, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ contents, mimeType: 'text/plain', targetLanguageCode: target, model: `projects/${project}/locations/global/models/general/nmt` }),
      }); } catch (error) {
        if (attempt === 3) throw new Error('Provider network/timeout retry budget exhausted; progress retained', { cause: error });
        await new Promise(r => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await new Promise(r => setTimeout(r, Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250)));
        continue;
      }
      if (!response.ok) throw new Error(`Translation request failed (${response.status}); progress retained`);
      const rows = (await response.json()).translations;
      if (!Array.isArray(rows) || rows.length !== batch.length) throw new Error('Provider returned wrong batch length');
      return rows.map((row, i) => protectedItems[i].restore(row.translatedText));
    }
    throw new Error('Translation retry budget exhausted');
  };
  const catalogs = [];
  const manifestLocales = {};
  for (const locale of locales) {
    for (const ns of namespaces) {
      const source = sources[ns];
      const messages = Object.create(null);
      let machine = false;
      const seed = await json(join(root, 'shared/i18n/reviewed', locale.code, ns + '.json'), { reviewed: false, messages: {} });
      const pending = new Map();
      for (const [key, value] of Object.entries(source)) {
        if (locale.code === 'en') { messages[key] = value; continue; }
        const reviewed = seed.reviewed === true && seed.messages?.[key];
        if (reviewed && reviewed.source === value) {
          validateMessages({ [key]: value }, { [key]: reviewed.text });
          messages[key] = reviewed.text; stats.reviewedMessages++; continue;
        }
        const cacheKey = hash({ providerVersion, locale: locale.code, target: locale.googleTarget, source: value });
        const path = join(cacheDir, locale.code, cacheKey + '.json');
        const cached = await json(path, null);
        if (cached?.source === value && cached.locale === locale.code && cached.providerVersion === providerVersion) {
          validateMessages({ [key]: value }, { [key]: cached.text });
          messages[key] = cached.text; machine = true; stats.reusedMessages++; continue;
        }
        if (!allowPaid || !locale.googleTarget || !supported.has(locale.googleTarget) || complexIcu.test(value)) {
          stats.missing.push({ locale: locale.code, namespace: ns, key, reason: complexIcu.test(value) ? 'review_required_icu' : !locale.googleTarget ? 'curated_translation_required' : 'not_generated' }); continue;
        }
        if (Array.from(value).length > 4000) throw new Error(`Message too large for bounded translation batch: ${ns}.${key}`);
        const item = pending.get(cacheKey) || { source: value, keys: [], path };
        item.keys.push(key); pending.set(cacheKey, item);
      }
      const queue = [...pending.values()];
      while (queue.length) {
        const batch = [];
        let count = 0;
        while (queue.length && batch.length < 50 && count + protect(queue[0].source).masked.length <= 5000) {
          const item = queue.shift(); batch.push(item); count += protect(item.source).masked.length;
        }
        if (!batch.length) throw new Error('Protected message exceeds batch size; split source message');
        const translations = await translateBatch(batch, locale.googleTarget);
        for (let i = 0; i < batch.length; i++) {
          const item = batch[i], text = translations[i];
          for (const key of item.keys) { validateMessages({ [key]: item.source }, { [key]: text }); messages[key] = text; }
          await atomic(item.path, { providerVersion, locale: locale.code, source: item.source, text });
        }
        machine = true;
      }
      if (Object.keys(messages).length !== Object.keys(source).length) continue;
      validateMessages(source, messages);
      const status = locale.code === 'en' ? 'source' : machine ? 'machine' : 'reviewed';
      const entry = manifestLocales[locale.code] ||= { namespaces: [], status };
      entry.namespaces.push(ns); if (machine) entry.status = 'machine';
      catalogs.push({ schemaVersion: 1, locale: locale.code, namespace: ns, messages, sourceHash: sourceHash(source) });
    }
  }
  // Content-address the complete release, including availability/provenance, before publishing.
  const release = hash({ catalogs, locales: manifestLocales, namespaces });
  const sourceHashes = Object.fromEntries(namespaces.map(ns => [ns, sourceHash(sources[ns])]));
  const manifest = { schemaVersion: 1, release, locales: manifestLocales, namespaces, sourceHashes };
  for (const catalog of catalogs) {
    const envelope = { ...catalog, release };
    if (Buffer.byteLength(canonical(envelope)) > 2 * 1024 * 1024) throw new Error('Catalog exceeds route byte limit; split namespace');
    await immutable(join(output, release, catalog.locale, catalog.namespace + '.json'), envelope);
  }
  await immutable(join(output, release, 'manifest.json'), manifest);
  // Preserve old source-specific pointers; unchanged source hashes can gain better translations.
  for (const digest of new Set(Object.values(sourceHashes))) await atomic(join(output, 'sources', digest, 'manifest.json'), manifest);
  await atomic(join(output, 'manifest.json'), manifest);
  const report = { release, elapsedMs: Date.now() - started, ...stats };
  await atomic(join(output, 'generation-report.json'), report);
  return report;
  } catch (error) {
    await atomic(join(output, 'generation-report.json'), {
      elapsedMs: Date.now() - started, ...stats, completed: false,
      error: error instanceof Error ? error.message : 'generation_failed',
      note: 'Partial progress retained in provider cache. Missing-key list covers processed namespaces only.',
    });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const args = new Set(process.argv.slice(2));
  const report = await generate({ root, output: resolve(process.env.UI_CATALOG_OUTPUT || join(root, 'artifacts/ui-catalogs')),
    cacheDir: resolve(process.env.UI_CATALOG_CACHE || join(root, 'artifacts/ui-catalog-cache')),
    allowPaid: args.has('--allow-paid'), maxCharacters: Number(process.env.UI_CATALOG_MAX_CHARACTERS || 0) });
  console.log(JSON.stringify({ release: report.release, elapsedMs: report.elapsedMs, providerCharactersAttempted: report.providerCharactersAttempted, providerRequests: report.providerRequests, missingCount: report.missing.length }));
}
