import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, protect, validateMessages, sourceHash } from './generate_catalogs.mjs';

test('protected placeholders, URLs and brands cannot be removed by provider', () => {
  const p = protect('Hello {name}, avaTOK https://avatok.ai/terms');
  assert.equal(p.restore(p.masked), 'Hello {name}, avaTOK https://avatok.ai/terms');
  assert.throws(() => p.restore(p.masked.replace('AVATOKTOKEN0END', 'name')));
  assert.throws(() => validateMessages({ x: '{name} has a ticket' }, { x: '{other} has a ticket' }));
  assert.throws(() => protect('{count, plural, one {ticket} other {tickets}}'));
  assert.equal(sourceHash({ b: 'B', a: 'A' }), sourceHash({ a: 'A', b: 'B' }));
});

test('source changes invalidate seeds; missing Indian languages stay absent; paid work is opt-in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-catalog-test-'));
  try {
    await mkdir(join(root, 'shared/i18n/source'), { recursive: true });
    await mkdir(join(root, 'shared/i18n/reviewed/hi'), { recursive: true });
    await writeFile(join(root, 'shared/i18n/locales.json'), JSON.stringify([{ code: 'en', googleTarget: null }, { code: 'hi', googleTarget: 'hi' }, { code: 'ks', googleTarget: null }]));
    await writeFile(join(root, 'shared/i18n/source/common.json'), JSON.stringify({ title: 'New title' }));
    await writeFile(join(root, 'shared/i18n/reviewed/hi/common.json'), JSON.stringify({ reviewed: true, messages: { title: { source: 'Old title', text: 'पुराना' } } }));
    const opts = { root, output: join(root, 'out'), cacheDir: join(root, 'cache'), fetchImpl: () => { throw new Error('Unexpected network'); } };
    const report = await generate(opts);
    const manifest = JSON.parse(await readFile(join(root, 'out/manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.locales), ['en']);
    assert.equal(report.missing.length, 2);
    assert.equal((await generate(opts)).release, report.release);
    await writeFile(join(root, 'shared/i18n/source/common.json'), JSON.stringify({ title: 'Changed again' }));
    const next = await generate(opts);
    assert.notEqual(next.release, report.release);
    const previousSource = sourceHash({ title: 'New title' });
    const oldPointer = JSON.parse(await readFile(join(root, 'out/sources', previousSource, 'manifest.json'), 'utf8'));
    assert.equal(oldPointer.release, report.release);
    assert.equal(oldPointer.sourceHashes.common, previousSource);
    const currentSource = sourceHash({ title: 'Changed again' });
    const currentPointer = JSON.parse(await readFile(join(root, 'out/sources', currentSource, 'manifest.json'), 'utf8'));
    assert.equal(currentPointer.release, next.release);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deduplicated generation resumes without retranslating and budget stops paid work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-catalog-paid-test-'));
  try {
    await mkdir(join(root, 'shared/i18n/source'), { recursive: true });
    await writeFile(join(root, 'shared/i18n/locales.json'), JSON.stringify([{ code: 'en', googleTarget: null }, { code: 'hi', googleTarget: 'hi' }]));
    await writeFile(join(root, 'shared/i18n/source/common.json'), JSON.stringify({ first: 'Hello', duplicate: 'Hello' }));
    let requests = 0;
    const opts = { root, output: join(root, 'out'), cacheDir: join(root, 'cache'), allowPaid: true, maxCharacters: 5,
      env: { GOOGLE_TRANSLATION_PROJECT: 'test-project', GOOGLE_TRANSLATION_ACCESS_TOKEN: 'fake-test-token' },
      fetchImpl: async (url, init) => {
        if (url.endsWith('supportedLanguages')) return Response.json({ languages: [{ languageCode: 'hi', supportTarget: true }] });
        requests++; assert.deepEqual(JSON.parse(init.body).contents, ['Hello']);
        return Response.json({ translations: [{ translatedText: 'नमस्ते' }] });
      } };
    const report = await generate(opts);
    assert.equal(requests, 1); assert.equal(report.providerCharactersAttempted, 5);
    await generate(opts); assert.equal(requests, 1);
    await writeFile(join(root, 'shared/i18n/source/common.json'), JSON.stringify({ title: 'A much longer new sentence' }));
    await assert.rejects(generate(opts), /budget exhausted/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
