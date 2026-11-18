import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionCatalog } from '../src/sqlCompletionCatalog.ts';

const emptySession = async () => ({ searchPath: [], schemas: [] });

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
  assert.equal(createCompletionCatalog(async () => ({}), emptySession).read('archive'), undefined);
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
  }, emptySession);
  const first = catalog.load('schema');
  await Promise.resolve();
  catalog.forget('schema');
  const refreshed = catalog.load('schema');
  finishOld({ stale: [] });
  await first;
  assert.equal(catalog.read('schema'), undefined);
  await refreshed;
  await catalog.load('schema');
  assert.equal(catalog.read('schema'), undefined);
  assert.equal(count, 2);
  catalog.forget('schema');
  await catalog.load('schema');
  assert.deepEqual(catalog.read('schema'), { fresh: [] });
  assert.equal(count, 3);
});

test('refreshes the session path after execution and clears columns only when requested', async () => {
  let current = 'public';
  let reads = 0;
  let fetches = 0;
  const catalog = createCompletionCatalog(async () => { fetches++; return { books: [] }; }, async () => {
    reads++;
    return { searchPath: [current], schemas: ['public', 'reporting'] };
  });
  assert.equal(catalog.session(), catalog.session());
  assert.deepEqual((await catalog.session()).searchPath, ['public']);
  await catalog.load('public');
  current = 'reporting';
  catalog.invalidate(false);
  assert.deepEqual((await catalog.session()).searchPath, ['reporting']);
  assert.equal(catalog.generation(), 1);
  await catalog.load('public');
  assert.equal(fetches, 1);
  catalog.invalidate(true);
  assert.equal(catalog.read('public'), undefined);
  await catalog.load('public');
  assert.equal(fetches, 2);
  assert.equal(reads, 2);
});

test('a session lookup that fails does not fall back to the sidebar or a stale path', async () => {
  let failed = false;
  const catalog = createCompletionCatalog(async () => ({}), async () => {
    if (failed) throw new Error('aborted transaction');
    return { searchPath: ['main'], schemas: ['main'] };
  });
  assert.deepEqual((await catalog.session()).searchPath, ['main']);
  failed = true;
  catalog.invalidate(true);
  assert.equal(await catalog.session(), null);
  failed = false;
  catalog.invalidate(true);
  assert.deepEqual((await catalog.session()).searchPath, ['main']);
});

test('foreign key lookups coalesce by schema and table and invalidate after metadata changes', async () => {
  const reads = [];
  const catalog = createCompletionCatalog(async () => ({}), emptySession, async (schema, table) => {
    reads.push([schema, table]);
    return [];
  });
  await catalog.load('sales');
  assert.deepEqual(reads, []);
  const first = catalog.loadForeignKeys('sales', 'orders');
  assert.equal(catalog.loadForeignKeys('sales', 'orders'), first);
  await Promise.all([first, catalog.loadForeignKeys('archive', 'orders')]);
  assert.deepEqual(reads, [['sales', 'orders'], ['archive', 'orders']]);
  assert.deepEqual(catalog.readForeignKeys('sales', 'orders'), []);
  catalog.invalidate(false);
  await catalog.loadForeignKeys('sales', 'orders');
  assert.equal(reads.length, 2);
  catalog.forget('billing');
  assert.equal(catalog.readForeignKeys('sales', 'orders'), undefined);
  await catalog.loadForeignKeys('sales', 'orders');
  catalog.invalidate(true);
  assert.equal(catalog.readForeignKeys('sales', 'orders'), undefined);
});
