// Node 20 CI: compile only this dependency-free controller with the existing TS dependency.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/lib/previewStore.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { createPreviewStore, PREVIEW_OFF } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
);
const ADMIN = { preview: true, guides: true, admin: true };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('late Clerk readiness retries an earlier missing/legacy guest token denial', async () => {
  let current = PREVIEW_OFF;
  let calls = 0;
  const store = createPreviewStore(async () => { calls++; return current; });
  const seen = [];
  store.subscribe(value => seen.push(value));
  assert.deepEqual(await store.get(), PREVIEW_OFF);
  current = ADMIN; // Real Clerk session becomes ready after initial timeout/guest denial.
  store.sessionChanged();
  assert.deepEqual(await store.get(), ADMIN);
  assert.equal(calls, 2);
  assert.equal(seen.at(-1).guides, true);
});

test('concurrent islands share one preview request per session', async () => {
  let calls = 0;
  const request = deferred();
  const store = createPreviewStore(() => { calls++; return request.promise; });
  const first = store.get();
  const second = store.get();
  assert.equal(first, second);
  request.resolve(ADMIN);
  await first;
  assert.equal(calls, 1);
});

test('admin to customer/signout hides immediately and resolves denied', async () => {
  for (const account of ['customer', 'signed-out']) {
    let response = Promise.resolve(ADMIN);
    const store = createPreviewStore(() => response);
    store.subscribe(() => {});
    await store.get();
    const next = deferred();
    response = next.promise;
    store.sessionChanged();
    assert.equal(store.snapshot().guides, false, account);
    assert.equal(store.snapshot().admin, false, account);
    next.resolve(PREVIEW_OFF);
    await store.get();
    assert.equal(store.snapshot().guides, false, account);
  }
});

test('an old admin response cannot restore visibility after the account changes', async () => {
  const old = deferred();
  let response = old.promise;
  const store = createPreviewStore(() => response);
  store.subscribe(() => {});
  const pendingAdmin = store.get();
  response = Promise.resolve(PREVIEW_OFF);
  store.sessionChanged();
  await store.get();
  old.resolve(ADMIN);
  assert.deepEqual(await pendingAdmin, PREVIEW_OFF);
  assert.equal(store.snapshot().guides, false);
});

test('failed requests fail closed and recover when the session becomes ready', async () => {
  let failed = true;
  const store = createPreviewStore(async () => {
    if (failed) throw new Error('network unavailable');
    return ADMIN;
  });
  assert.deepEqual(await store.get(), PREVIEW_OFF);
  failed = false;
  store.sessionChanged();
  assert.deepEqual(await store.get(), ADMIN);
});
