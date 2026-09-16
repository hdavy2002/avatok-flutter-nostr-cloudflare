#!/usr/bin/env node
/** CI publication gate: independently re-read source, verify every file and release digest. */
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, sourceHash, validateMessages } from './generate_catalogs.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.argv[2] || join(root, 'artifacts/ui-catalogs'));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const manifest = await json(join(output, 'manifest.json'));
const locales = await json(join(root, 'shared/i18n/locales.json'));
const codes = new Set(locales.map(l => l.code));
if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.release) || !Array.isArray(manifest.namespaces) || !manifest.namespaces.length || new Set(manifest.namespaces).size !== manifest.namespaces.length || !manifest.namespaces.every(n => /^[a-z][a-z0-9_-]{0,63}$/.test(n)) || !manifest.locales?.en || !Object.keys(manifest.locales).every(l => codes.has(l))) throw new Error('Invalid release manifest');
if (!manifest.sourceHashes || Object.keys(manifest.sourceHashes).length !== manifest.namespaces.length) throw new Error('Missing namespace source hashes');
for (const ns of manifest.namespaces) {
  if (manifest.sourceHashes[ns] !== sourceHash(await json(join(root, 'shared/i18n/source', ns + '.json')))) throw new Error('Manifest source hash mismatch');
}
const catalogs = [];
for (const locale of locales) {
  const entry = manifest.locales[locale.code];
  if (!entry) continue;
  if (!['source', 'reviewed', 'machine'].includes(entry.status) || !Array.isArray(entry.namespaces) || !entry.namespaces.length || new Set(entry.namespaces).size !== entry.namespaces.length || !entry.namespaces.every(n => manifest.namespaces.includes(n))) throw new Error('Invalid locale namespace availability');
  for (const namespace of manifest.namespaces) {
    if (!entry.namespaces.includes(namespace)) continue;
    const text = await readFile(join(output, manifest.release, locale.code, namespace + '.json'), 'utf8');
    const envelope = JSON.parse(text);
    const source = await json(join(root, 'shared/i18n/source', namespace + '.json'));
    if (Buffer.byteLength(text) > 2 * 1024 * 1024 || envelope.schemaVersion !== 1 || envelope.release !== manifest.release || envelope.locale !== locale.code || envelope.namespace !== namespace || envelope.sourceHash !== sourceHash(source)) throw new Error('Catalog/source mismatch');
    if (Object.keys(envelope).sort().join(',') !== 'locale,messages,namespace,release,schemaVersion,sourceHash') throw new Error('Unexpected envelope fields');
    validateMessages(source, envelope.messages);
    const { release, ...catalog } = envelope;
    catalogs.push(catalog);
  }
}
if (hash({ catalogs, locales: manifest.locales, namespaces: manifest.namespaces }) !== manifest.release) throw new Error('Release content hash mismatch');
console.log(JSON.stringify({ release: manifest.release, verifiedCatalogs: catalogs.length }));
