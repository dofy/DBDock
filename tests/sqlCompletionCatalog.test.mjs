import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionCatalog } from '../src/sqlCompletionCatalog.ts';

test('completion metadata is loaded only for requested schemas, coalesced, and isolated per session', async () => {
  const calls = [];
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const catalog = createCompletionCatalog(async (name) => {
    calls.push(name);
    if (name === 'public') await waiting;
    return { items: [{ name: name + '_id', dataType: 'integer', nullable: false }] };
  });
  assert.equal(catalog.read('public'), undefined);
  const first = catalog.load('public');
  assert.equal(catalog.load('public'), first);
  const second = catalog.load('archive');
  await Promise.resolve();
  assert.deepEqual(calls, ['public']);
  release();
  await Promise.all([first, second]);
  await catalog.load('archive');
  assert.deepEqual(calls, ['public', 'archive']);
  assert.equal(catalog.read('archive').items[0].name, 'archive_id');
  assert.equal(catalog.read('public').items[0].name, 'public_id');
  assert.equal(createCompletionCatalog(async () => ({})).read('archive'), undefined);
});

test('refresh replaces an outstanding schema lookup and retries a cached failure', async () => {
  let count = 0;
  let finishOld;
  const oldRows = new Promise((resolve) => { finishOld = resolve; });
  const catalog = createCompletionCatalog(async () => {
    count++;
    if (count === 1) return oldRows;
    if (count === 2) throw new Error('disconnected');
    return { fresh: [] };
  });
  const first = catalog.load('schema');
  await Promise.resolve();
  const refreshed = catalog.reload('schema');
  finishOld({ stale: [] });
  await first;
  assert.equal(catalog.read('schema'), undefined);
  await refreshed;
  await catalog.load('schema');
  assert.equal(catalog.read('schema'), undefined);
  assert.equal(count, 2);
  await catalog.reload('schema');
  assert.deepEqual(catalog.read('schema'), { fresh: [] });
  assert.equal(count, 3);
});
